using System.Text;

namespace ThreadMemoryCli;

internal static class CliHelp
{
    internal static string Overview(IEnumerable<string> commands)
    {
        var text = new StringBuilder("Usage: Thread-Memory COMMAND [OPTIONS]\n\nCommands:\n");
        foreach (string command in commands)
            text.AppendLine($"  {command,-15}{Describe(command).Purpose}");
        return text.Append("""

            Run Thread-Memory COMMAND --help for inputs, output, and an example.
            Commands default to CODEX_THREAD_ID. Rollout queries also accept --rollout PATH.
            Queries return JSON by default. Memory commands use plain text.
            """).ToString();
    }

    internal static string ForCommand(string command, string[] options)
    {
        var (purpose, example, details) = Describe(command);
        string operands = command switch
        {
            "search" => " PATTERN",
            "instructions" => " --window N",
            "tool-input" or "tool-output" => " (--id ID | --cursor CURSOR)",
            "export-image" or "export-audio" => " --id ID",
            _ => "",
        };
        var text = new StringBuilder($"Usage: Thread-Memory {command}{operands} [OPTIONS]\n\n");
        text.Append(purpose).Append('\n').Append(details).Append("\n\n")
            .Append("Example: Thread-Memory ").Append(command).Append(' ').Append(example)
            .Append("\n\nOptions:\n");
        foreach (string option in options)
        {
            var (value, explanation) = DescribeOption(command, option);
            string syntax = value.Length > 0 ? $"{option} {value}" : option;
            text.Append("  ").Append(syntax.PadRight(28)).Append("  ").Append(explanation).Append('\n');
        }
        return text.Append("  --help, -h                    Show this help.").ToString();
    }

    private static (string Purpose, string Example, string Details) Describe(string command) => command switch
    {
        "memory" => ("Read or write a persistent Markdown thread note.", "", ""),
        "diagnostics" => ("Read recorded Thread Memory hook activity.", "--limit 10",
            "JSON .items lists recent events, newest first. With --summary, it contains aggregate reminder counts."),
        "inspect" => ("Summarize the available rollout segments and compaction checkpoints.", "--thread UUID",
            "JSON includes segments, checkpoint_count, and up to five recent checkpoints. Use windows for the full list."),
        "lineage" => ("Trace a thread's fork ancestry and rollout sources.", "--thread UUID",
            "JSON fork_chain starts with the selected thread. fork_chain_end explains why the walk stopped."),
        "windows" => ("List compaction windows and their source locations.", "--window current",
            "JSON .items lists matching windows. Add --with-tokens for totals or pass next_cursor to --cursor to continue."),
        "tokens" => ("Report recorded token usage in the selected scope.", "--window current --by-response --limit 5",
            "JSON shows usage totals. Choose --by-response or --by-summary to also return .items and next_cursor."),
        "inventory" => ("Count rollout records by type and role.", "--window current --limit 10",
            "JSON .items contains grouped counts and example.ref. Use read --ref REF to inspect that record."),
        "search" => ("Find literal text in readable rollout fields and tool metadata.", "\"checkpoint_ready\" --limit 5",
            "Read JSON .items for hits and their ref values. Use read --ref REF for more text.\n" +
            "For a pattern starting with '-', put options first and place -- before the pattern."),
        "read" => ("Read rollout record metadata and selected text.", "--window current --limit 5",
            "JSON .items contains fields and refs. Use tool-input or tool-output for payloads identified by input_id or output_id."),
        "tool-input" => ("Read a tool call's arguments by input_id.", "--id ID --lines 10:20",
            "Get input_id from read or search in the same source. JSON .items contains text. Use --pointer for a typed .value."),
        "tool-output" => ("Read a tool call's result by output_id.", "--id ID --lines 10:20",
            "Get output_id from read or search in the same source. JSON .items contains text. Use --pointer for a typed .value."),
        "instructions" => ("Read system or developer messages in a compaction snapshot.", "--window 2 --role developer --limit 5",
            "Find checkpoint numbers with windows. JSON .items[].checkpoint_item is the index accepted by --item."),
        "transcript" => ("Read recorded user and assistant messages.", "--window current --last 5",
            "JSON .items contains messages and refs. Use --format markdown for text or --cursor for forward pagination."),
        "images" => ("List image metadata and image IDs without exporting files.", "--window current --limit 5",
            "JSON has .items and next_cursor. Pass image_id to export-image using the same source."),
        "attachments" => ("List image and audio metadata without exporting files.", "--media audio --role user --limit 5",
            "JSON has .items and next_cursor. Items include media, kind, availability, and recorded paths when present.\n" +
            "Pass image_id to export-image or audio attachment_id to export-audio with the same source.\n" +
            "Only one selector can read from stdin."),
        "export-image" => ("Export images selected by image_id.", "--id ID --max-resolution 512",
            "JSON .images reports thumbnail_file and any embedded_file. With --original, read original_file.\n" +
            "Check unknown_ids and each item's export_error for failures."),
        "export-audio" => ("Export audio selected by attachment_id.", "--id ID",
            "JSON .attachments reports audio_file when available. Check unknown_ids and each item's export_error for failures."),
        "recover" => ("Find messages and images missing from a compaction snapshot.", "--window 2 --max-images 0",
            "Check JSON status and candidate counts. Results show content missing verbatim from the replacement history."),
        _ => throw new InvalidOperationException($"Missing help for {command}."),
    };

    private static (string Value, string Explanation) DescribeOption(string command, string option) => option switch
    {
        "--thread" => ("UUID", "Select a thread (default: CODEX_THREAD_ID)."),
        "--rollout" => ("PATH", "Read a specific rollout file instead of selecting a thread."),
        "--previous" => ("PATH", "Provide a referenced predecessor rollout. Repeat for multiple files."),
        "--output" => ("NEW_PATH", "Save the result to a new file and print a JSON receipt."),
        "--salvage" => ("", "Skip damaged rollout records and report their locations."),
        "--codex-home" => ("PATH", "Select the Codex home (default: CODEX_HOME or ~/.codex)."),
        "--since" => ("TIME", command == "windows"
            ? "Match windows overlapping this inclusive lower bound. Use ISO 8601 with a zone."
            : "Include records at or after an ISO 8601 timestamp with a zone."),
        "--until" => ("TIME", command == "windows"
            ? "Match windows overlapping this exclusive upper bound. Use ISO 8601 with a zone."
            : "Include records before an ISO 8601 timestamp with a zone."),
        "--origin" => ("ORIGIN", "Filter history ownership: all (default), current, inherited, or unknown."),
        "--window" => command switch
        {
            "instructions" => ("N", "Required numbered compaction checkpoint from windows."),
            "recover" => ("N", "Numbered checkpoint from windows (default: latest own checkpoint in the active rollout)."),
            _ => ("N|current", "Select a numbered checkpoint window or the open window."),
        },
        "--segment" => ("NAME_OR_ID", "Restrict to one rollout segment."),
        "--lines" => command is "tool-input" or "tool-output"
            ? ("N|START:END", "Page through N payload lines (default: 20) or jump to a 1-based inclusive range.")
            : ("START:END", "Select 1-based inclusive physical JSONL lines in each segment."),
        "--turn" => ("ID", "Restrict to a recorded turn."),
        "--limit" => command switch
        {
            "diagnostics" => ("N", "Return up to N recent events (default: 20, maximum: 2048)."),
            "tokens" => ("N", "Return up to N detail items per page (default: 20)."),
            _ => ("N", "Return up to N items per page (default: 20)."),
        },
        "--cursor" => command switch
        {
            "tool-input" or "tool-output" => ("CURSOR|-", "Resume next_cursor or read it from stdin. Omit --id, --lines, --pointer, and --budget-chars."),
            "tokens" => ("CURSOR|-", "Resume next_cursor with the same scope and detail mode. Use - for one stdin line."),
            _ => ("CURSOR|-", "Resume next_cursor with the same query. Use - for one stdin line."),
        },
        "--max-chars" => command switch
        {
            "recover" => ("N", "Cap total message excerpt characters (default: 2400, 0 for images only)."),
            "transcript" or "instructions" => ("N", "Cap each item excerpt (default: 1000 characters)."),
            _ => ("N", "Cap each record excerpt (default: 400 characters)."),
        },
        "--budget-chars" => ("N", "Cap text per page (default: 4000 characters)."),
        "--type" => ("TYPE", "Match a record kind or type shown by inventory. Repeat to include more types."),
        "--role" => command switch
        {
            "transcript" => ("ROLE", "Choose user or assistant. Repeat for both."),
            "instructions" => ("ROLE", "Choose system or developer. Repeat for both."),
            _ => ("ROLE", "Choose user, assistant, system, developer, or tool. Repeat for more roles."),
        },
        "--with-tokens" => ("", "Add token_usage totals to each returned window."),
        "--by-response" => ("", "Add paged per-response usage. Omit --by-summary."),
        "--by-summary" => ("", "Page encrypted summary counts and matched output token counts."),
        "--summary" => ("", "Count reminders across threads. Omit --thread and --limit."),
        "--tool" => ("NAME", "Match the exact tool name."),
        "--regex" => ("", "Treat PATTERN as a .NET regular expression."),
        "--ignore-case" => ("", "Match text case-insensitively (alias: -i)."),
        "--before" => ("N", "Include up to N preceding records, 0 to 20 (alias: -B)."),
        "--after" => ("N", "Include up to N following records, 0 to 20 (alias: -A)."),
        "--ref" => command == "read"
            ? ("REF|-", "Reopen one record or field in the same source, or read one ref from stdin. Replaces history filters.")
            : ("REF|-", "Catalog attachments on one record, or read one ref from stdin. Replaces history ranges."),
        "--metadata-only" => ("", "Show record metadata and body_available without text."),
        "--field" => ("NAME", "Read a field by name."),
        "--field-index" => ("N", "Read a field by zero-based index."),
        "--chars" => ("START:END", "Read a zero-based character slice with END excluded."),
        "--id" => command switch
        {
            "tool-input" => ("ID|-", "Select one input_id, or read one ID from stdin."),
            "tool-output" => ("ID|-", "Select one output_id, or read one ID from stdin."),
            "export-image" => ("ID|-", "Select an image_id. Repeat --id or pipe one or more IDs, one per line, to --id -."),
            "export-audio" => ("ID|-", "Select an audio attachment_id. Repeat --id or pipe one or more IDs, one per line, to --id -."),
            _ => throw new InvalidOperationException($"Missing ID help for {command}."),
        },
        "--pointer" => ("JSON_POINTER", "Select a typed JSON value. Use '' for the root and omit --lines."),
        "--item" => ("N", "Select the zero-based checkpoint_item index."),
        "--last" => ("N", "Return the newest N messages in chronological order. Omit --limit and --cursor."),
        "--phase" => ("PHASE", "Match the recorded assistant phase: final, commentary, or partial."),
        "--format" => ("FORMAT", "Choose json (default) or markdown."),
        "--media" => ("TYPE", "Choose image or audio. Omit to include both."),
        "--kind" => ("KIND", "Choose inline, local, or reference."),
        "--output-dir" => ("DIR", "Write exported files to this directory (default: temporary directory)."),
        "--original" => ("", "Return the original image file only. Omit --scale and --max-resolution."),
        "--scale" => ("RATIO", command == "recover"
            ? "Set export thumbnail scale, greater than 0 and at most 1 (default: 0.25, or 1 with an explicit cap)."
            : "Set thumbnail scale, greater than 0 and at most 1 (default: 1)."),
        "--max-resolution" => ("PIXELS", $"Cap both thumbnail dimensions (default: {HistoryMedia.DefaultResolution})."),
        "--max-images" => ("N", "Return up to N images (default: 8, 0 for text only)."),
        "--export-images" => ("[DIR]", "Export selected image files (default directory: temporary)."),
        "--max-messages" => ("N", "Return up to N messages (default: 8, 0 for images only)."),
        _ => throw new InvalidOperationException($"Missing help for {option}."),
    };
}
