using System.Text.Json;
using System.Text.Json.Nodes;

namespace ThreadMemoryCli;

internal sealed class HistoryTokens
{
    private const string SummaryField = "encrypted_summary_output_tokens";
    private static readonly string[] UsageFields =
    [
        "input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens",
        "reasoning_output_tokens", "total_tokens",
    ];

    private sealed record Response(JsonObject Location, string? TurnId, JsonObject Usage);
    private sealed record Summary(string Cursor, string? ResponseId, JsonObject Details);

    private readonly Dictionary<string, Response> responses = new(StringComparer.Ordinal);
    private readonly List<Summary> summaries = [];

    internal static JsonObject Run(CliOptions args, HistorySource source)
    {
        bool byResponse = args.Has("--by-response");
        bool bySummary = args.Has("--by-summary");
        string? cursor = args.One("--cursor");
        var usage = new HistoryTokens();
        foreach (var row in source.Rows(includeRevision: false))
            usage.Add(row);

        var report = usage.Report();
        report["encrypted_summary_count"] = usage.summaries.Count;
        if (!byResponse && !bySummary)
            return report;

        var items = new JsonArray();
        int limit = args.Integer("--limit", 20, minimum: 1);
        string? next = null;
        string? last = null;
        var details = byResponse ? usage.Responses() : usage.EncryptedSummaries();
        foreach (var (key, item) in details)
        {
            if (cursor is not null)
            {
                if (key == cursor)
                    cursor = null;
                continue;
            }
            if (items.Count == limit)
            {
                next = last;
                break;
            }
            items.Add((JsonNode?)item);
            last = key;
        }
        if (cursor is not null)
            throw new CliInputException("unknown token usage cursor in the selected scope");
        report["items"] = items;
        report["next_cursor"] = next;
        return report;
    }

    internal void Add(HistoryRow row)
    {
        if (row.Type == "token_usage_record")
        {
            var payload = row.Payload;
            var usage = payload.Get("usage");
            if (payload.Text("response_id") is not { Length: > 0 } id || usage.ValueKind != JsonValueKind.Object)
                return;
            var counts = new JsonObject();
            foreach (var field in UsageFields)
                counts[field] = HistoryMetadata.Count(usage.Get(field));
            // A repeated provider record replaces its value without moving its position.
            responses[id] = new Response(HistoryMetadata.Location(row), payload.Text("turn_id"), counts);
            return;
        }

        if (!(row.Type == "compacted" || (row.Type == "response_item" && row.ItemType is "compaction" or "compaction_summary" or "context_compaction"))
            || RecordProjection.Encrypted(row.Value) is not { } encrypted)
            return;

        var details = HistoryMetadata.Location(row);
        details["window"] = row.Type == "compacted" ? HistoryMetadata.Count(row.Payload.Get("window_number")) : null;
        foreach (var (name, value) in encrypted)
            details[name] = value?.DeepClone();
        summaries.Add(new Summary(row.Cursor, row.Payload.Text("compaction_response_id"), details));
    }

    internal JsonObject WindowReport()
    {
        var report = Report();
        report["encrypted_summaries"] = new JsonArray(EncryptedSummaries().Select(entry => entry.Item).ToArray());
        return report;
    }

    private JsonObject Report()
    {
        var sums = new long[UsageFields.Length];
        var coverage = new long[UsageFields.Length];
        foreach (var response in responses.Values)
        {
            for (int i = 0; i < UsageFields.Length; i++)
            {
                if (response.Usage[UsageFields[i]] is not { } tokens)
                    continue;
                sums[i] = checked(sums[i] + tokens.GetValue<long>());
                coverage[i]++;
            }
        }
        var totals = new JsonObject();
        var observed = new JsonObject();
        for (int i = 0; i < UsageFields.Length; i++)
        {
            totals[UsageFields[i]] = coverage[i] > 0 ? sums[i] : (long?)null;
            observed[UsageFields[i]] = coverage[i];
        }

        var compactionCounts = new Dictionary<string, long>(StringComparer.Ordinal);
        foreach (var summary in summaries)
            if (summary.ResponseId is { Length: > 0 } id && OutputFor(summary) is long count)
                compactionCounts[id] = count;
        totals[SummaryField] = compactionCounts.Count > 0 ? compactionCounts.Values.Sum() : (long?)null;
        observed[SummaryField] = compactionCounts.Count;
        return new JsonObject
        {
            ["totals"] = totals,
            ["response_count"] = responses.Count,
            ["responses_with_usage"] = observed,
        };
    }

    private long? OutputFor(Summary summary)
    {
        if (summary.ResponseId is { } id && responses.TryGetValue(id, out var response)
            && response.Usage["output_tokens"] is { } output)
            return output.GetValue<long>();
        return summary.Details["tokens"]?.GetValue<long>();
    }

    private IEnumerable<(string Key, JsonObject Item)> Responses()
    {
        foreach (var (id, response) in responses)
        {
            var item = (JsonObject)response.Location.DeepClone();
            item["response_id"] = id;
            item["turn_id"] = response.TurnId;
            item["usage"] = response.Usage.DeepClone();
            yield return (id, item);
        }
    }

    private IEnumerable<(string Key, JsonObject Item)> EncryptedSummaries()
    {
        foreach (var summary in summaries)
        {
            var item = (JsonObject)summary.Details.DeepClone();
            item["response_id"] = summary.ResponseId;
            item["tokens"] = OutputFor(summary);
            yield return (summary.Cursor, item);
        }
    }
}
