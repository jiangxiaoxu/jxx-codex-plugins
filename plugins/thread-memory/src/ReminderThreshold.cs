using System.Globalization;
using System.Text;
using System.Text.Json;
using Tomlyn;
using Tomlyn.Model;
using Tomlyn.Parsing;
using Tomlyn.Serialization;

namespace ThreadMemoryHook;

internal sealed record ReminderPlan((int Tier, long FirstAt)[] Levels, long? UsableWindow, long LeadTokens)
{
    public const int DefaultLeadTokens = 45_000;
    public const int CheckLeadTokens = 35_000;
    public const int FinalCheckLeadTokens = 25_000;

    private const string StartupTokensEnvironment = "THREAD_MEMORY_ASYNC_START_TOKENS";
    private const string LeadTokensEnvironment = "THREAD_MEMORY_HANDOFF_LEAD_TOKENS";
    private static readonly UTF8Encoding Utf8 = new(false, true);

    public static ReminderPlan? Resolve(string home, string? model)
    {
        try
        {
            var lead = ParseTokens(Environment.GetEnvironmentVariable(LeadTokensEnvironment), DefaultLeadTokens);
            if (lead is null)
                return null;

            var startupSetting = Environment.GetEnvironmentVariable(StartupTokensEnvironment);
            if (startupSetting is not null)
            {
                var startup = ParseTokens(startupSetting, null);
                return startup is long limit && limit > lead.Value
                    ? new ReminderPlan([(0, limit - lead.Value)], null, lead.Value)
                    : null;
            }

            return ResolveConfig(home, model, lead.Value);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException
            or ArgumentException or NotSupportedException or TomlException or JsonException or OverflowException)
        {
            // The hook can run while optional configuration and model metadata are being updated.
            return null;
        }
    }

    public IEnumerable<(int Tier, int Stage)> Reached(long used)
    {
        foreach (var (tier, firstAt) in Levels)
        {
            if (used < firstAt)
                continue;

            var remaining = firstAt + LeadTokens - used;
            if (LeadTokens > FinalCheckLeadTokens && remaining <= FinalCheckLeadTokens)
                yield return (tier, 2);
            else if (LeadTokens > CheckLeadTokens && remaining <= CheckLeadTokens)
                yield return (tier, 1);
            else
                yield return (tier, 0);
        }
    }

    private static long? ParseTokens(string? setting, long? fallback)
    {
        if (setting is null)
            return fallback;

        var text = setting.AsSpan().Trim();
        if (text.ContainsAnyExceptInRange('0', '9'))
            return null;

        return long.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var tokens) && tokens > 0
            ? tokens
            : null;
    }

    internal static TomlTable ReadConfig(string home)
    {
        var config = Utf8.GetString(File.ReadAllBytes(Path.Combine(home, "config.toml")));
        if (config.StartsWith('\uFEFF'))
            throw new TomlException("Unexpected byte order mark in Codex configuration.");

        // The untyped deserializer can merge repeated dotted keys unless the document is validated first.
        SyntaxParser.ParseStrict(config, validate: true);
        return TomlSerializer.Deserialize(config, ConfigTomlContext.Default.TomlTable)
            ?? throw new TomlException("Missing Codex configuration.");
    }

    private static ReminderPlan? ResolveConfig(string home, string? model, long lead)
    {
        var config = ReadConfig(home);
        if (!config.TryGetValue("features", out var rawFeatures) || rawFeatures is not TomlTable features)
            return null;

        var tokenBudget = features.TryGetValue("token_budget", out var configuredBudget) ? configuredBudget : false;
        if (tokenBudget is TomlTable budget)
            tokenBudget = budget.TryGetValue("enabled", out var enabled) ? enabled : false;
        if (tokenBudget is not false)
            return null;

        if (!features.TryGetValue("async_compaction", out var asyncCompaction))
            return null;

        var percents = new SortedSet<int> { 65, 80 };
        if (asyncCompaction is TomlTable compaction)
        {
            if (compaction.TryGetValue("model_async_compact_threshold_percent", out var percent))
            {
                if (percent is not long value || value is < 1 or > 100)
                    return null;

                percents.Add((int)value);
            }
            asyncCompaction = compaction.TryGetValue("enabled", out var enabled) ? enabled : false;
        }
        if (asyncCompaction is not true || string.IsNullOrEmpty(model))
            return null;

        var window = ResolveWindow(home, config, model);
        if (window is not { } resolved)
            return null;

        var levels = new List<(int Tier, long FirstAt)>();
        foreach (var percent in percents)
        {
            // Compaction starts when active tokens reach the rounded-up percentage of the raw window.
            var firstAt = (long)(((Int128)resolved.Raw * percent + 99) / 100) - lead;
            if (firstAt > 0)
                levels.Add((percent, firstAt));
        }

        return levels.Count > 0 ? new ReminderPlan(levels.ToArray(), resolved.Usable, lead) : null;
    }

    private static (long Raw, long Usable)? ResolveWindow(string home, TomlTable config, string model)
    {
        long? modelOverride = null;
        if (config.TryGetValue("model_context_window", out var rawOverride))
        {
            if (rawOverride is not long value || value <= 0)
                return null;

            modelOverride = value;
        }

        var path = Path.Combine(home, "models_cache.json");
        if (config.TryGetValue("model_catalog_json", out var rawCatalogPath))
        {
            if (rawCatalogPath is not string catalogPath || string.IsNullOrWhiteSpace(catalogPath))
                return null;

            path = ResolveCatalogPath(home, catalogPath);
        }

        var bytes = File.ReadAllBytes(path);
        Utf8.GetCharCount(bytes);
        using var catalog = JsonDocument.Parse(bytes);
        var root = catalog.RootElement;
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("models", out var entries)
            || entries.ValueKind != JsonValueKind.Array)
            return null;

        foreach (var entry in entries.EnumerateArray())
        {
            if (entry.ValueKind != JsonValueKind.Object || !entry.TryGetProperty("slug", out var slug)
                || slug.ValueKind != JsonValueKind.String || !slug.ValueEquals(model))
                continue;

            long? max = null;
            if (entry.TryGetProperty("max_context_window", out var maxWindow) && maxWindow.ValueKind != JsonValueKind.Null)
            {
                max = PositiveTokens(maxWindow);
                if (max is null)
                    return null;
            }

            var raw = max;
            if (modelOverride is long configured)
                raw = Math.Min(configured, max ?? configured);
            else if (entry.TryGetProperty("context_window", out var contextWindow) && contextWindow.ValueKind != JsonValueKind.Null)
                raw = PositiveTokens(contextWindow);

            var usablePercent = entry.TryGetProperty("effective_context_window_percent", out var percent) ? PositiveTokens(percent) : 95;
            if (raw is null || usablePercent is null or > 100)
                return null;

            return (raw.Value, (long)((Int128)raw.Value * usablePercent.Value / 100));
        }

        return null;
    }

    private static long? PositiveTokens(JsonElement value)
        => value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var tokens) && tokens > 0 ? tokens : null;

    private static string ResolveCatalogPath(string home, string path)
    {
        if (path == "~" || path.StartsWith("~/", StringComparison.Ordinal) || path.StartsWith("~\\", StringComparison.Ordinal))
        {
            var profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            if (profile.Length > 0)
                return Path.Join(profile, path.AsSpan(1).TrimStart("/\\"));
        }

        return Path.GetFullPath(path, Path.GetFullPath(home));
    }
}

[TomlSerializable(typeof(TomlTable))]
[TomlSourceGenerationOptions(DuplicateKeyHandling = TomlDuplicateKeyHandling.Error)]
internal partial class ConfigTomlContext : TomlSerializerContext;
