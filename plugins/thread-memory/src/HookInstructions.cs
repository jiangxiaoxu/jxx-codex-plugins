using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;

namespace ThreadMemoryHook;

internal static class HookInstructions
{
    private const int Recorded = 3;
    private const int RecoveryScanBytes = 4 * 1024 * 1024;
    private const string Maintenance = "<thread_memory_maintenance>\n" +
        "Proactively maintain a concise note for this thread with $thread-memory. " +
        "When important decisions, constraints, progress, or next steps change, update the note and replace stale details.\n" +
        "</thread_memory_maintenance>";

    public static string? Get(JsonElement request, string home)
    {
        var hookEvent = Text(request, "hook_event_name");
        var source = hookEvent == "SessionStart" ? Text(request, "source") : null;
        var agentValue = Field(request, "agent_id");
        var hasAgent = !Missing(agentValue);
        if (hasAgent ? hookEvent is not ("SubagentStart" or "PostCompact" or "PostToolUse") :
            source is not ("startup" or "compact" or "fork") && hookEvent != "PostToolUse")
            return null;
        if (!Guid.TryParse(Text(request, "session_id"), out var session) ||
            Text(request, "transcript_path") is not { Length: > 0 } path)
            return null;

        try
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete);
            var header = SessionFiles.ReadHeader(path, stream);
            var store = new HookStore(home);
            if (hasAgent)
            {
                if (!Guid.TryParse(Text(agentValue), out var agent) || agent == session ||
                    !Matches(header, "id", agent) || !MatchesWhenPresent(header, "session_id", session) ||
                    !Unattached(header) || Field(Field(Field(header, "source"), "subagent"), "thread_spawn")
                        .ValueKind != JsonValueKind.Object)
                    return null;
                return Subagent(request, hookEvent!, home, path, stream, agent.ToString(), store);
            }
            if (!IsRoot(header, session))
                return null;

            var thread = session.ToString();
            if (source == "startup")
            {
                store.Diagnostic(thread, "startup_context_prepared");
                return Maintenance;
            }
            if (source is "compact" or "fork")
            {
                var note = ThreadMemory.NoteStatus(store, home, thread);
                var details = new JsonObject { ["note_status"] = note };
                if (source == "fork")
                {
                    store.Diagnostic(thread, "fork_note_checked", details: details);
                    return null;
                }
                Probe(store, path, stream, thread);
                store.Diagnostic(thread, "compact_context_prepared", details: details);
                return Recovery(note == "available"
                    ? "Context was compacted. Use `memory read` to recover the thread note. Search the rollout for missing details as needed."
                    : "Context was compacted. Search the rollout for earlier context as needed.");
            }
            return CompactionReminder(request, store, home, path, stream, thread);
        }
        catch (Exception error) when (OptionalStateFailure(error))
        {
            return null;
        }
    }

    private static string? Subagent(JsonElement request, string hookEvent, string home, string path,
        FileStream stream, string thread, HookStore store)
    {
        if (hookEvent == "SubagentStart")
        {
            store.Diagnostic(thread, "subagent_start_context_prepared",
                details: new JsonObject { ["note_status"] = "not_checked" });
            return Maintenance;
        }
        if (hookEvent == "PostCompact")
        {
            store.MarkCompaction(thread);
            Probe(store, path, stream, thread);
            store.Diagnostic(thread, "subagent_compaction_pending");
            return null;
        }
        if (store.TakeCompaction(thread))
        {
            Probe(store, path, stream, thread);
            store.Diagnostic(thread, "subagent_recovery_context_prepared");
            return Recovery("Context was compacted in this subagent. Use `memory read` to recover your thread note. " +
                "Search the rollout for missing details as needed.");
        }
        return CompactionReminder(request, store, home, path, stream, thread);
    }

    private static RolloutSnapshot? Probe(HookStore store, string path, FileStream stream, string thread,
        long minimumUsed = 0, string? turn = null, string? model = null, int scanBytes = RecoveryScanBytes)
    {
        try
        {
            var file = RolloutPath.Resolve(path, stream);
            string? checkpoint = null;
            try
            {
                checkpoint = store.LoadCheckpoint(thread, file.Key);
            }
            catch (Exception error) when (OptionalStateFailure(error))
            {
                // A verified tail scan can still provide evidence.
            }

            var scan = RolloutScanner.Scan(stream, file, checkpoint, ReadAliases, minimumUsed, turn, model, scanBytes);
            if (scan is null)
                return null;
            if ((scan.Receipts.Count != 0 || scan.Compactions.Count != 0) &&
                !store.Telemetry(thread, receipts: scan.Receipts, compactions: scan.Compactions))
                return scan;
            if (scan.Checkpoint is { } next && (next != checkpoint || scan.Aliases.Count != 0))
            {
                try
                {
                    store.SaveCheckpoint(thread, file.Key, checkpoint, next, scan.Aliases);
                }
                catch (Exception error) when (OptionalStateFailure(error))
                {
                    // Persistence is optional after verifying the rollout.
                }
            }
            return scan;

            IReadOnlyList<StoredCheckpoint> ReadAliases()
            {
                try
                {
                    return store.LoadCheckpointAliases(thread, file.Key);
                }
                catch (Exception error) when (OptionalStateFailure(error))
                {
                    return [];
                }
            }
        }
        catch (Exception error) when (OptionalStateFailure(error))
        {
            return null;
        }
    }

    private static string? CompactionReminder(JsonElement request, HookStore store, string home,
        string path, FileStream stream, string thread)
    {
        var model = Text(request, "model");
        var plan = ReminderPlan.Resolve(home, model);
        if (plan is null)
            return null;
        var state = Probe(store, path, stream, thread, plan.Levels[0].FirstAt,
            Text(request, "turn_id"), model, RolloutScanner.ScanBytes);
        if (state?.Window is not { } window || state.Used is not long used ||
            (state.Capacity is long capacity && plan.UsableWindow is long usable && capacity != usable))
            return null;

        var phases = plan.Reached(used).Select(item => (
            item.Tier, Stage: state.ReceivedLevels.Contains(item.Tier) ? Recorded : item.Stage)).ToArray();
        var claimed = store.Claim(thread, window, phases, state.EquivalentWindows);
        if (claimed.Count == 0)
            return null;

        var marker = RolloutScanner.ReminderWindowId(window);
        var leads = (First: plan.LeadTokens,
            Check: plan.LeadTokens > ReminderPlan.CheckLeadTokens ? (long)ReminderPlan.CheckLeadTokens : 0,
            Final: plan.LeadTokens > ReminderPlan.FinalCheckLeadTokens ? (long)ReminderPlan.FinalCheckLeadTokens : 0);
        var startups = plan.Levels.ToDictionary(item => item.Tier, item => item.FirstAt + plan.LeadTokens);
        var decisions = phases.Where(item => claimed.Contains(item.Tier))
            .Select(item => (item.Tier, item.Stage, Startup: startups[item.Tier])).ToArray();
        store.Telemetry(thread, window, marker, leads, used, decisions);

        var confirmations = decisions.Where(item => item.Stage == Recorded).ToArray();
        if (confirmations.Length > 0)
            store.Diagnostic(thread, "reminder_receipt_observed", window, Details(confirmations));
        var notices = decisions.Where(item => item.Stage != Recorded).ToArray();
        if (notices.Length == 0)
            return null;

        store.Diagnostic(thread, "reminder_context_prepared", window, Details(notices));
        const string reminder = "The current context window may be compressed soon. Use $thread-memory to update the current thread note.";
        var context = notices.Any(item => item.Stage != 0)
            ? $"This may be a duplicate reminder. {reminder} If no update is needed, ignore this reminder."
            : $"{reminder} Keep only what is needed to resume the work.";
        var levels = string.Join(',', notices.Select(item => item.Tier.ToString(CultureInfo.InvariantCulture)));
        return $"<thread_memory_reminder>\n{context}\nNotify ID: [{levels}:{marker}]\n</thread_memory_reminder>";

        JsonObject Details((int Tier, int Stage, long Startup)[] subset) => new()
        {
            ["used"] = used,
            ["capacity"] = state.Capacity is long observed ? JsonValue.Create(observed) : null,
            ["notify_id"] = marker,
            ["leads"] = new JsonArray(leads.First, leads.Check, leads.Final),
            ["estimated_startups"] = new JsonArray(startups.Select(item => (JsonNode)new JsonArray(item.Key, item.Value)).ToArray()),
            ["stages"] = new JsonArray(subset.Select(item => (JsonNode)new JsonArray(item.Tier, item.Stage)).ToArray()),
        };
    }

    private static bool IsRoot(JsonElement header, Guid session)
    {
        if (!Matches(header, "id", session) || !MatchesWhenPresent(header, "session_id", session) ||
            !Unattached(header) || !Missing(Field(header, "parent_thread_id")) ||
            !Missing(Field(header, "subagent_history_start_ordinal")))
            return false;
        var source = Field(header, "source");
        if (source.ValueKind == JsonValueKind.String)
        {
            var value = source.GetString()!;
            if (value.Equals("subagent", StringComparison.OrdinalIgnoreCase) ||
                value.Equals("internal", StringComparison.OrdinalIgnoreCase) ||
                value.StartsWith("subagent_", StringComparison.OrdinalIgnoreCase) ||
                value.StartsWith("internal_", StringComparison.OrdinalIgnoreCase))
                return false;
        }
        else if (source.ValueKind != JsonValueKind.Undefined &&
            (source.ValueKind != JsonValueKind.Object || Text(source, "custom") is null ||
             source.EnumerateObject().Count() != 1))
            return false;
        var threadSource = Field(header, "thread_source");
        return Missing(threadSource) || Text(threadSource) is { } text &&
            text is not ("subagent" or "guardian_review" or "memory_consolidation");
    }

    private static bool OptionalStateFailure(Exception error) => error is
        IOException or UnauthorizedAccessException or JsonException or SqliteException or ArgumentException;

    private static bool Unattached(JsonElement header) =>
        Field(header, "attached_thread").ValueKind is JsonValueKind.False or JsonValueKind.Undefined;

    private static bool MatchesWhenPresent(JsonElement item, string key, Guid expected) =>
        Field(item, key).ValueKind == JsonValueKind.Undefined || Matches(item, key, expected);

    private static bool Matches(JsonElement item, string key, Guid expected) =>
        Guid.TryParse(Text(item, key), out var id) && id == expected;

    private static JsonElement Field(JsonElement item, string key) =>
        item.ValueKind == JsonValueKind.Object && item.TryGetProperty(key, out var value) ? value : default;

    private static bool Missing(JsonElement item) => item.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null;

    private static string? Text(JsonElement item, string key) => Text(Field(item, key));

    private static string? Text(JsonElement value) => value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static string Recovery(string text) =>
        $"<thread_memory_recovery>\n{text}\n</thread_memory_recovery>\n\n{Maintenance}";
}
