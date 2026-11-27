using System.Globalization;
using System.Text;
using ThreadMemoryHook;

namespace ThreadMemoryCli;

internal sealed class CliOptions
{
    private const string Source = "--thread --rollout --previous --output --salvage --codex-home";
    private const string Time = "--since --until --origin";
    private const string Scope = $"{Time} --window --segment --lines --turn";
    private const string Page = "--limit --cursor";
    private const string TextPage = $"{Page} --max-chars --budget-chars";
    private const string Filter = "--type --role";
    private const int MaxSelectorBytes = 256 * 1024;
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private static readonly HashSet<string> Switches = [
        "--salvage", "--with-tokens", "--by-response", "--by-summary", "--metadata-only", "--summary",
        "--regex", "--ignore-case", "--original"
    ];
    private static readonly HashSet<string> Nonnegative = [
        "--before", "--after", "--field-index", "--item", "--max-images", "--max-messages"
    ];
    private static readonly HashSet<string> Positive = ["--limit", "--last", "--budget-chars", "--max-resolution"];
    private static readonly Dictionary<string, string> Commands = new(StringComparer.Ordinal)
    {
        ["memory"] = "--thread --codex-home",
        ["diagnostics"] = "--thread --codex-home --summary --limit",
        ["inspect"] = Source,
        ["lineage"] = Source,
        ["windows"] = $"{Source} {Time} {Page} --window --with-tokens",
        ["tokens"] = $"{Source} {Scope} {Page} --by-response --by-summary",
        ["inventory"] = $"{Source} {Scope} {Filter} {Page}",
        ["search"] = $"{Source} {Scope} {Filter} {TextPage} --tool --regex --ignore-case --before --after --format",
        ["read"] = $"{Source} {Scope} {Filter} {TextPage} --tool --ref --metadata-only --field --field-index --chars",
        ["tool-input"] = $"{Source} --id --lines --pointer --budget-chars --cursor",
        ["tool-output"] = $"{Source} --id --lines --pointer --budget-chars --cursor",
        ["instructions"] = $"{Source} {TextPage} --window --role --item --chars",
        ["transcript"] = $"{Source} {Scope} {TextPage} --role --last --phase --format",
        ["images"] = $"{Source} {Scope} {Page} --ref --kind --role",
        ["attachments"] = $"{Source} {Scope} {Page} --ref --media --kind --role",
        ["export-image"] = $"{Source} --id --output-dir --original --scale --max-resolution",
        ["export-audio"] = $"{Source} --id --output-dir",
        ["recover"] = $"{Source} --window --max-images --export-images --scale --max-resolution --max-messages --max-chars",
    };
    private readonly Dictionary<string, List<string>> values = new(StringComparer.Ordinal);

    private CliOptions(string command) => Command = command;

    internal string Command { get; }
    internal string? Pattern { get; private set; }
    internal bool Help { get; private set; }
    internal string Home => Path.GetFullPath(One("--codex-home") ??
        Environment.GetEnvironmentVariable("CODEX_HOME") ??
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex"));
    internal string? Thread => One("--thread") is { Length: > 0 } thread
        ? thread : Environment.GetEnvironmentVariable("CODEX_THREAD_ID");

    internal string? One(string name) => values.TryGetValue(name, out var result) ? result[^1] : null;
    internal IReadOnlyList<string> Many(string name) => values.TryGetValue(name, out var result) ? result : [];
    internal bool Has(string name) => values.ContainsKey(name);
    internal string Require(string name) => One(name) ?? throw Invalid($"{name} is required.");

    internal int Integer(string name, int fallback, int minimum = 1, int maximum = int.MaxValue) =>
        One(name) is string value ? ParseInteger(name, value, minimum, maximum) : fallback;

    private static int ParseInteger(string name, string value, int minimum, int maximum)
    {
        if (!int.TryParse(value, CultureInfo.InvariantCulture, out int result) || result < minimum || result > maximum)
            throw Invalid(maximum == int.MaxValue ? $"{name} requires an integer of at least {minimum}." :
                $"{name} requires an integer from {minimum} to {maximum}.");
        return result;
    }

    internal static CliOptions Parse(string[] args)
    {
        if (args is ["--help" or "-h"])
            return new CliOptions("") { Help = true };
        if (args.Length == 0 || !Commands.TryGetValue(args[0], out string? optionList))
            throw Invalid(args.Length == 0 ? "A command is required." : $"Unknown command: {args[0]}.");

        var options = new CliOptions(args[0]);
        var allowed = optionList.Split(' ').ToHashSet(StringComparer.Ordinal);
        bool export = options.Command is "export-image" or "export-audio";
        bool media = export || options.Command is "images" or "attachments" or "recover";
        bool positionals = false;
        for (int i = 1; i < args.Length; i++)
        {
            string argument = args[i];
            if (!positionals && argument == "--")
            {
                positionals = true;
                continue;
            }
            if (positionals || !argument.StartsWith('-') || argument == "-")
            {
                if (options.Command is not ("memory" or "search") || options.Pattern is not null)
                    throw Invalid(export ? "Unexpected attachment export argument. Repeat --id or pipe IDs to --id -."
                        : media ? $"Unexpected argument for {options.Command}." : $"Unexpected argument: {argument}.");
                if (options.Command == "memory" && argument is not ("read" or "write"))
                    throw Invalid($"Unknown memory action: {argument}. Use read or write.");
                options.Pattern = argument;
                continue;
            }
            if (argument is "--help" or "-h")
            {
                options.Help = true;
                return options;
            }

            int equals = argument.IndexOf('=');
            string rawName = equals < 0 ? argument : argument[..equals];
            string name = rawName switch { "-B" => "--before", "-A" => "--after", "-i" => "--ignore-case", _ => rawName };
            if (!allowed.Contains(name))
                throw Invalid(media
                    ? $"Unknown option for {options.Command}."
                    : $"Unknown option for {options.Command}: {rawName}.");
            string? value = equals < 0 ? null : argument[(equals + 1)..];
            if (Switches.Contains(name))
            {
                if (value is not null)
                    throw Invalid($"{name} takes no value.");
                options.values[name] = [""];
                continue;
            }

            if (value is null && i + 1 < args.Length && (!args[i + 1].StartsWith('-') || args[i + 1] == "-"))
                value = args[++i];
            value ??= name == "--export-images" ? "" : throw Invalid($"{name} requires a value.");
            bool path = name is "--rollout" or "--previous" or "--codex-home" or "--output" or "--output-dir" or "--export-images";
            if ((path || name == "--segment") && IsInlineMediaArgument(value))
            {
                string expected = path ? "a filesystem path" : "a rollout name or ID";
                throw Invalid($"{name} requires {expected}. Received an inline data URL.");
            }
            if (name is "--previous" or "--role" or "--type" || name == "--id" && export)
            {
                if (!options.values.TryGetValue(name, out var occurrences))
                    options.values.Add(name, occurrences = []);
                occurrences.Add(value);
            }
            else
                options.values[name] = [value];
        }
        options.Validate();
        return options;
    }

    private static bool IsInlineMediaArgument(string value)
    {
        ReadOnlySpan<char> selector = value.AsSpan().TrimStart();
        if (!selector.IsEmpty && selector[0] is '"' or '\'')
            selector = selector[1..].TrimStart();
        return selector.StartsWith("data:", StringComparison.OrdinalIgnoreCase) ||
            MediaText.ContainsDataUrl(value);
    }

    internal void ResolveStdin()
    {
        var readers = new[] { "--id", "--cursor", "--ref" }.Where(Has)
            .SelectMany(name => Many(name).Where(value => value == "-").Select(_ => name)).ToArray();
        if (readers.Length == 0)
            return;
        if (readers is not [var option])
            throw new CliInputException("Use - only once across --id, --ref, and --cursor.");
        using var input = Console.OpenStandardInput();
        byte[] buffer = new byte[MaxSelectorBytes + 1];
        int size = input.ReadAtLeast(buffer, buffer.Length, false);
        if (size > MaxSelectorBytes)
            throw new CliInputException($"{option} - input exceeds {MaxSelectorBytes} UTF-8 bytes.");
        var raw = buffer.AsSpan(0, size);
        if (raw.StartsWith(Encoding.UTF8.Preamble))
            raw = raw[Encoding.UTF8.Preamble.Length..];
        var lines = Utf8.GetString(raw).Replace("\r\n", "\n").TrimEnd('\n').Split('\n');
        if (lines.Any(string.IsNullOrWhiteSpace))
            throw new CliInputException($"{option} - requires nonempty UTF-8 input lines.");
        bool batch = Command is "export-image" or "export-audio";
        if (!batch && lines.Length != 1)
            throw new CliInputException($"{option} - requires exactly one input line.");
        var selected = values[option];
        int index = selected.IndexOf("-");
        selected.RemoveAt(index);
        selected.InsertRange(index, lines);
    }

    internal string Usage()
    {
        if (Command.Length == 0)
            return CliHelp.Overview(Commands.Keys);
        if (Command == "memory")
            return MemoryUsage();
        return CliHelp.ForCommand(Command, Commands[Command].Split(' '));
    }

    private string MemoryUsage()
    {
        string action = Pattern ?? "{read|write}";
        string noteLimit = Program.MaxNoteBytes.ToString("N0", CultureInfo.InvariantCulture);
        string description = action switch
        {
            "read" => """
                Write only the saved UTF-8 Markdown to stdout.
                Output is empty when the thread has no saved note.
                """,
            "write" => $"""
                Create or replace the whole note with UTF-8 Markdown from stdin.
                Notes over {noteLimit} UTF-8 bytes are shortened, with a warning in the save receipt.
                """,
            _ => """
                read   Print only the saved Markdown.
                write  Create or replace the whole note with UTF-8 Markdown on stdin.

                Use Thread-Memory memory ACTION --help for details.
                """,
        };
        string example = action == "write" ? "'## Current goal' | Thread-Memory memory write" : "Thread-Memory memory read";
        return $"""
            Usage: Thread-Memory memory {action} [OPTIONS]

            {description}

            Writes report saved bytes, with a notice over {Program.NoteNoticeThresholdKiB} KiB.
            Command errors print the reason to stderr and exit nonzero.
            A closed output pipe exits quietly with code 141.

            Example: {example}

            Options:
              --thread UUID      Select a thread (default: CODEX_THREAD_ID).
              --codex-home PATH  Use a different Codex home.
              --help, -h         Show this help.
            """;
    }

    private void Validate()
    {
        if (Command == "memory" && Pattern is null)
            throw Invalid("memory requires read or write.");
        if (Command == "search" && Pattern is null)
            throw Invalid("search requires a pattern.");
        if (Command == "search" && Pattern?.Length == 0)
            throw new CliInputException("Search pattern must not be empty.");
        Exclusive("--thread", "--rollout");
        Exclusive("--by-response", "--by-summary");
        Exclusive("--field", "--field-index", "--metadata-only");
        Exclusive("--last", "--cursor");
        if (Command == "diagnostics" && Has("--summary") && (Has("--thread") || Has("--limit")))
            throw Invalid("--summary applies to all threads and cannot use --thread or --limit.");
        if (Command is "tool-input" or "tool-output")
        {
            Exclusive("--id", "--cursor");
            Exclusive("--lines", "--pointer");
            if (!Has("--id") && !Has("--cursor"))
                throw Invalid("Tool details require --id or --cursor.");
            if (Has("--cursor") && new[] { "--lines", "--pointer", "--budget-chars" }.Any(Has))
                throw Invalid("--cursor already selects tool detail options.");
        }
        if (Command is "export-image" or "export-audio" && !Has("--id"))
            throw Invalid("--id is required.");
        if (Has("--original") && (Has("--scale") || Has("--max-resolution")))
            throw Invalid("--original cannot be combined with thumbnail sizing options.");
        if (Command == "instructions" && !Has("--window"))
            throw Invalid("--window is required.");
        if (Command == "tokens" && Has("--cursor") && !Has("--by-response") && !Has("--by-summary"))
            throw Invalid("tokens --cursor requires --by-response or --by-summary.");
        if (Has("--ref"))
        {
            if (new[] { "--segment", "--lines", "--turn", "--window", "--since", "--until" }.Any(Has) ||
                One("--origin") is string origin && origin != "all")
                throw Invalid("--ref selects a record in place of the history filters.");
            if (Command == "read" &&
                new[] { "--type", "--role", "--field", "--field-index", "--tool", "--metadata-only", "--cursor" }.Any(Has))
                throw Invalid("--ref already selects the record and text projection.");
        }
        if (Has("--metadata-only") && Has("--chars"))
            throw Invalid("--metadata-only cannot be combined with --chars.");

        foreach (var name in values.Keys)
        {
            if (Positive.Contains(name) || name == "--max-chars" && Command != "recover")
                Integer(name, 1);
            else if (Nonnegative.Contains(name) || name == "--max-chars")
                Integer(name, 0, 0, name is "--before" or "--after" ? 20 : int.MaxValue);
        }
        if (Has("--window") && (One("--window") != "current" || Command is "instructions" or "recover"))
            Integer("--window", 0, minimum: 0);
        if (One("--lines") is string lines)
        {
            if (Command is "tool-input" or "tool-output" && !lines.Contains(':'))
                Integer("--lines", 20);
            else
                ValidateRange("--lines", lines, min: 1, inclusive: true);
        }
        if (One("--chars") is string chars)
            ValidateRange("--chars", chars, min: 0, inclusive: false);
        if (Command == "diagnostics")
            Integer("--limit", 20, maximum: 2048);
        Choice("--origin", "all", "current", "inherited", "unknown");
        Choice("--format", "json", "markdown");
        Choice("--kind", "inline", "local", "reference");
        Choice("--media", "image", "audio");
        Choice("--phase", "final", "commentary", "partial");
        Choice("--role", Command switch
        {
            "transcript" => ["user", "assistant"],
            "instructions" => ["system", "developer"],
            _ => ["user", "assistant", "system", "developer", "tool"],
        });
        if (One("--scale") is string scale &&
            (!double.TryParse(scale, CultureInfo.InvariantCulture, out double ratio) || !(ratio is > 0 and <= 1)))
            throw Invalid("--scale must be greater than 0 and at most 1.");
        var since = Timestamp("--since");
        var until = Timestamp("--until");
        if (since is not null && until is not null && since >= until)
            throw Invalid("--since must be earlier than --until.");
    }

    internal DateTimeOffset? Timestamp(string name)
    {
        if (One(name) is not string value)
            return null;
        if (!HistorySource.TryInstant(value, out var time))
            throw Invalid($"{name} requires an ISO 8601 timestamp with time zone.");
        return time;
    }

    private void Exclusive(params string[] options)
    {
        if (options.Count(Has) > 1)
            throw Invalid($"Use one of {string.Join(", ", options)}.");
    }

    private static void ValidateRange(string name, string value, int min, bool inclusive)
    {
        var pieces = value.Split(':');
        if (pieces.Length != 2 ||
            !long.TryParse(pieces[0], NumberStyles.None, CultureInfo.InvariantCulture, out long start) ||
            !long.TryParse(pieces[1], NumberStyles.None, CultureInfo.InvariantCulture, out long end) ||
            start < min || end < start || !inclusive && end == start)
            throw Invalid($"{name} requires a {(inclusive ? "1-based inclusive" : "0-based half-open")} START:END range.");
    }

    private void Choice(string name, params string[] choices)
    {
        if (Many(name).Any(value => !choices.Contains(value, StringComparer.Ordinal)))
            throw Invalid($"{name} requires one of {string.Join(", ", choices)}.");
    }

    private static CliInputException Invalid(string message) => new(message, "invalid_arguments");
}
