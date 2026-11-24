using System.Text.RegularExpressions;

namespace ThreadMemoryHook;

internal static partial class MediaText
{
    private const string Base64Text = @"[a-z0-9+/=_%\-]";
    private const string UnpaddedBase64 = @"[a-z0-9+/_\-]";
    private const string EndOfToken = """(?=[ \t]*(?:\r?\n|\z)|[)"'<>}\]])""";
    private const string WrappedLines =
        "(?:(?:" + UnpaddedBase64 + "{64}|" + UnpaddedBase64 + "{76})\\r?\\n(?=" +
        Base64Text + "{4,}" + EndOfToken + "))*";
    private const string PaddedContinuation = "(?:\\r?\\n" + UnpaddedBase64 + "{2,}={1,2}" + EndOfToken + ")?";

    // Include percent signs even when the escape is malformed so redaction
    // retains neither the rest of the token nor recognizable wrapped lines.
    [GeneratedRegex("""data:[^\s"'<>;,]*(?:;[^\s"'<>;,]+)*;base64,[ \t\r\n]*""" +
        WrappedLines + Base64Text + "*" + PaddedContinuation,
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex DataUrl();

    internal static bool ContainsDataUrl(string text) =>
        text.Contains("data:", StringComparison.OrdinalIgnoreCase) && DataUrl().IsMatch(text);

    internal static string OmitDataUrls(string text) =>
        text.Contains("data:", StringComparison.OrdinalIgnoreCase) ? DataUrl().Replace(text, "[data URL omitted]") : text;
}
