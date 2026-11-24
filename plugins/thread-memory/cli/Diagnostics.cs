using System.Globalization;
using System.Text.Json.Nodes;
using ThreadMemoryHook;

namespace ThreadMemoryCli;

internal static class Diagnostics
{
    internal static JsonObject Run(CliOptions args)
    {
        bool summary = args.Has("--summary");
        string? threadId = null;
        if (!summary)
        {
            if (!Guid.TryParse(args.Thread, out var thread))
                throw new CliInputException("diagnostics requires --thread UUID or CODEX_THREAD_ID.", "invalid_arguments");
            threadId = thread.ToString("D");
        }

        var items = new JsonArray();
        var result = new JsonObject { ["items"] = items };
        if (threadId is not null)
            result["thread_id"] = threadId;
        using var connection = new HookStore(args.Home).OpenRead();
        if (connection is null)
            return result;
        using var command = connection.CreateCommand();
        if (summary)
        {
            command.CommandText = """
                SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'reminder_telemetry_totals'
                """;
            if (command.ExecuteScalar() is null)
                return result;
            command.CommandText = """
                SELECT leads, tier, metric, bucket, count FROM reminder_telemetry_totals
                ORDER BY leads, tier, metric, bucket
                """;
            using var rows = command.ExecuteReader();
            while (rows.Read())
            {
                long bucket = rows.GetInt64(3);
                items.Add((JsonNode)new JsonObject
                {
                    ["leads"] = JsonNode.Parse(rows.GetString(0)),
                    ["tier"] = rows.GetInt32(1),
                    ["metric"] = rows.GetString(2),
                    ["remaining_tokens_bucket"] = bucket == long.MinValue ? null : bucket,
                    ["count"] = rows.GetInt64(4),
                });
            }
        }
        else
        {
            command.CommandText = """
                SELECT timestamp_us, event, window, details FROM hook_diagnostics
                WHERE thread_id = $thread ORDER BY id DESC LIMIT $limit
                """;
            command.Parameters.AddWithValue("$thread", threadId!);
            command.Parameters.AddWithValue("$limit", args.Integer("--limit", 20, maximum: 2048));
            using var rows = command.ExecuteReader();
            while (rows.Read())
            {
                var item = new JsonObject
                {
                    ["timestamp"] = DateTimeOffset.UnixEpoch.AddTicks(checked(rows.GetInt64(0) * 10))
                        .ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff'Z'", CultureInfo.InvariantCulture),
                    ["event"] = rows.GetString(1),
                };
                if (!rows.IsDBNull(2))
                    item["window"] = rows.GetString(2);
                if (!rows.IsDBNull(3))
                    item["details"] = JsonNode.Parse(rows.GetString(3));
                items.Add((JsonNode)item);
            }
        }
        return result;
    }
}
