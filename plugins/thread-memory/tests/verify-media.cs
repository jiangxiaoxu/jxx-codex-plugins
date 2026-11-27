using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

if (args.Length > 1)
{
    Console.Error.WriteLine("Usage: dotnet run --file verify-media.cs -- [Thread-Memory.exe]");
    return 2;
}

string cli = Path.GetFullPath(args.FirstOrDefault() ??
    Environment.GetEnvironmentVariable("THREAD_MEMORY_TEST_CLI_EXE") ?? PackagedCli());
if (!File.Exists(cli))
{
    Console.Error.WriteLine("Thread-Memory.exe was not found. Build the Native AOT CLI or pass its path.");
    return 2;
}

const string ImageData = "iVBORw0KGgoAAAANSUhEUgAAAAwAAAAGCAYAAAD37n+BAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAWSURBVChTY/i/lOE/KZgBXYAQHg4aACHFvdn3n82xAAAAAElFTkSuQmCC";
const string AudioData = "UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQIAAACAgQ==";
const string ImageMarker = "VBORw0KGgoAAAANSUhEUgAAAAwAAAAGCAYAAAD37n";
const string AudioMarker = "UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQIAAACAgQ";
const string JpegSignature = "/9j/4AAQSkZJRgABAQEASABIAAD/2Q==";
const string Redacted = "[data URL omitted]";
const string Thread = "00000000-0000-4000-8000-000000000026";
const string Time = "2026-01-01T00:00:00Z";
const string RawImageUrl = "data:image/png;base64," + ImageData;
const string RawAudioUrl = "data:audio/wav;base64," + AudioData;
const int ScenarioCount = 6;

string home = Directory.CreateTempSubdirectory("thread-memory-media-").FullName;
string sessions = Directory.CreateDirectory(Path.Combine(home, "sessions")).FullName;
string rollout = Path.Combine(sessions, $"rollout-2026-01-01T00-00-00-{Thread}.jsonl");
byte[] imageBytes = Convert.FromBase64String(ImageData);
byte[] audioBytes = Convert.FromBase64String(AudioData);
int passed = 0;

try
{
    await Check("inline data is redacted from text and diagnostics", TextRedaction);
    await Check("typed JPEG data stays hidden while local paths remain visible", TypedImageRedaction);
    await Check("raw signatures export to files while malformed URLs stay private", MalformedMedia);
    await Check("legacy user attachments honor complete image order", LegacyImageOrder);
    await Check("stdin selectors export local and inline attachments", SelectAttachments);
    await Check("search and original image export work without the imaging DLL", WithoutImagingLibrary);
    Console.WriteLine($"Passed {passed}/{ScenarioCount} media scenarios.");
    return passed == ScenarioCount ? 0 : 1;
}
finally
{
    Directory.Delete(home, recursive: true);
}

async Task Check(string scenario, Func<Task> test)
{
    try
    {
        await test();
    }
    catch (VerificationException error)
    {
        Console.Error.WriteLine($"Failed {scenario}. {error.Message}");
        return;
    }
    catch (Exception error) when (error is IOException or UnauthorizedAccessException or InvalidOperationException
        or JsonException or KeyNotFoundException or TimeoutException)
    {
        Console.Error.WriteLine($"Failed {scenario} ({error.GetType().Name}).");
        return;
    }
    ++passed;
    Console.WriteLine($"Passed {scenario}.");
}

async Task TextRedaction()
{
    string escapedUrl = "data:image/png;base64,%69" + ImageData[1..];
    string malformedUrl = "data:image/png;base64,%ZZ" + ImageData[1..];
    string wrappedUrl = $"data:image/png;base64,{ImageData[..76]}\r\n{ImageData[76..]}";
    string shortLine = $"data:audio/wav;base64,{AudioData[..4]}\n{AudioData[4..]}";
    Seed(Message($"image reference {escapedUrl}\nsecond reference {malformedUrl}\n{wrappedUrl}\n{shortLine}\nordinary prose remains"),
        Checkpoint(),
        Message("image reference outside the selected window"));

    string destination = Path.Combine(home, "search.json");
    JsonElement receipt = await Query(["search", "image reference", "--since", Time,
        "--window", "1", "--output", destination]);
    Require(receipt.GetProperty("output").GetString() == destination, "Search did not return its output file.");
    string document = File.ReadAllText(destination);
    ContainsRedaction(document, "Search result file");
    using var search = JsonDocument.Parse(document);
    Require(search.RootElement.GetProperty("items").GetArrayLength() == 1,
        "Scoped search missed its text record.");

    CliResult markdown = await Invoke(["transcript", "--format", "markdown"]);
    ExpectExit(markdown, 0);
    ContainsRedaction(markdown.Output, "Markdown transcript");
    Require(!markdown.Output.Contains(ImageData[76..], StringComparison.Ordinal) &&
        !markdown.Output.Contains(AudioData[4..], StringComparison.Ordinal), "Wrapped media escaped the redaction.");
    Require(markdown.Output.Contains("ordinary prose remains", StringComparison.Ordinal),
        "Media redaction removed the following prose.");

    CliResult regex = await Invoke(["search", "--regex", "[" + malformedUrl]);
    ExpectExit(regex, 1);
    ContainsRedaction(regex.Error, "Invalid regex diagnostic");

    string baseFile = Path.Combine(home, "data");
    File.WriteAllText(baseFile, "existing file");
    string alternateStream = baseFile + ":;base64," + ImageData;
    foreach (string invalid in new[] { $"\"{RawImageUrl}\"", $"[\"{RawImageUrl}\"]", alternateStream })
    {
        CliResult rejected = await Invoke(["inspect", "--output", invalid]);
        ExpectExit(rejected, 2);
        using var diagnostic = JsonDocument.Parse(rejected.Error);
        Require(diagnostic.RootElement.GetProperty("error").GetProperty("code").GetString() == "invalid_arguments",
            "Inline path argument did not report invalid_arguments.");
    }
    Require(!File.Exists(alternateStream) && File.ReadAllText(baseFile) == "existing file",
        "An inline path argument changed the filesystem.");
}

async Task TypedImageRedaction()
{
    const string callId = "call-image";
    const string local = "/9j/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/file.jpg";
    string wrappedJpeg = JpegSignature[..4] + "\r\n" + JpegSignature[4..];
    Seed(Row("response_item", new JsonObject
    {
        ["type"] = "function_call", ["name"] = "view_image", ["call_id"] = callId,
        ["arguments"] = "{}",
    }), Row("response_item", new JsonObject
    {
        ["type"] = "function_call_output", ["call_id"] = callId,
        ["output"] = new JsonArray(Image(JpegSignature), Image(wrappedJpeg), Image(local)),
    }), Message("images", Image(JpegSignature), Image(wrappedJpeg), Image(local)));

    JsonElement results = await Query(["search", callId, "--tool", "view_image"]);
    string outputId = results.GetProperty("items").EnumerateArray().Single(row => row.TryGetProperty("output_id", out _))
        .GetProperty("output_id").GetString()!;
    JsonElement line = One(await Query(["tool-output", "--id", outputId]), "items");
    Require(line.GetProperty("text").GetString()!.TrimEnd() == local,
        "The line view did not preserve the real path while omitting the JPEG.");

    JsonElement output = (await Query(["tool-output", "--id", outputId, "--pointer", "/output"])).GetProperty("value");
    Require(output[0].ValueKind == JsonValueKind.Null && output[1].ValueKind == JsonValueKind.Null &&
        output[2].GetProperty("path").GetString() == local,
        "The pointer view did not preserve the real path while omitting the JPEG.");

    JsonElement hit = One(await Query(["search", "/9j/"]), "items");
    Require(hit.GetProperty("text").GetString() == local,
        "Search did not preserve the real path while omitting the JPEG.");
    JsonElement record = One(await Query(["read", "--lines", "4:4"]), "items");
    Require(record.GetProperty("fields").EnumerateArray().Any(field => field.GetProperty("text").GetString() == local),
        "The message record did not preserve the real path while omitting the JPEG.");
}

async Task LegacyImageOrder()
{
    const string local = "local.png";
    string[] files = ["file-image-1", "file-image-2"];
    foreach (bool complete in new[] { true, false })
    {
        Seed(Row("event_msg", new JsonObject
        {
            ["type"] = "user_message", ["message"] = "mixed images",
            ["images"] = new JsonArray(RawImageUrl, RawImageUrl),
            ["file_ids"] = new JsonArray(files[0], files[1]),
            ["local_images"] = new JsonArray(local),
            ["image_order"] = complete
                ? new JsonArray("file", "inline", "file", "inline")
                : new JsonArray("file", "inline", "file"),
        }));

        JsonElement images = (await Query(["images"])).GetProperty("items");
        string[] expected = complete
            ? [files[0], "inline", files[1], "inline", local]
            : ["inline", "inline", files[0], files[1], local];
        Require(images.EnumerateArray().Select(image => image.GetProperty("kind").GetString() switch
        {
            "reference" => image.GetProperty("reference").GetString(),
            "local" => image.GetProperty("path").GetString(),
            _ => "inline",
        }).SequenceEqual(expected), complete
            ? "Complete image order did not interleave the split images."
            : "Incomplete image order did not retain the full legacy order.");
    }
}

async Task MalformedMedia()
{
    Seed(Message("attachments", Image(" \tdata:image/png;base64,\r\n" + ImageData), Image(ImageData),
        Audio(" \tdata:audio/wav;base64,\r\n" + AudioData), Audio(AudioData)), Checkpoint());
    JsonElement catalog = await Query(["attachments"]);
    string[] imageIds = Ids(catalog, "image", "image_id");
    string[] audioIds = Ids(catalog, "audio", "attachment_id");
    Require(imageIds.Length == 2 && audioIds.Length == 2, "Catalog did not return both variants for each medium.");

    string destination = Path.Combine(home, "raw-exports");
    JsonElement images = await Query(["export-image", "--id", imageIds[0], "--id", imageIds[1],
        "--original", "--output-dir", destination]);
    JsonElement audio = await Query(["export-audio", "--id", audioIds[0], "--id", audioIds[1],
        "--output-dir", destination]);
    await Query(["recover"]);
    VerifyRawExport(images, "images", "original_file", imageBytes);
    VerifyRawExport(audio, "attachments", "audio_file", audioBytes);
    Require(Directory.EnumerateFiles(destination).Count() == 2, "Malformed media produced an output file.");
}

async Task SelectAttachments()
{
    string local = Path.Combine(home, "local.png");
    File.WriteAllBytes(local, imageBytes);
    Seed(Message("attachments", Image(RawImageUrl), Audio(RawAudioUrl)),
        Row("event_msg", new JsonObject
        {
            ["type"] = "user_message", ["local_images"] = new JsonArray(Path.GetFileName(local)),
        }));

    JsonElement transcript = await Query(["transcript"]);
    string reference = One(transcript, "items").GetProperty("ref").GetString()!;
    JsonElement catalog = await Query(["attachments", "--ref", "-"], reference + "\n");
    string inlineId = Ids(catalog, "image", "image_id").Single();
    string audioId = Ids(catalog, "audio", "attachment_id").Single();
    JsonElement localCatalog = await Query(["images", "--kind", "local"]);
    string localId = One(localCatalog, "items").GetProperty("image_id").GetString()!;

    string destination = Path.Combine(home, "selected");
    JsonElement report = await Query(["export-image", "--id", "-", "--max-resolution", "4",
        "--output-dir", destination], $"{localId}\n{inlineId}\n");
    Require(report.GetProperty("unknown_ids").GetArrayLength() == 0, "Selected image ID was not resolved.");
    JsonElement images = report.GetProperty("images");
    Require(images.GetArrayLength() == 2 && images[0].GetProperty("resolved_path").GetString() == local,
        "The selected local and inline images were not returned in input order.");
    Require(File.ReadAllBytes(images[1].GetProperty("embedded_file").GetString()!).AsSpan().SequenceEqual(imageBytes),
        "Export changed the inline image bytes.");
    foreach (JsonElement image in images.EnumerateArray())
    {
        byte[] thumbnail = File.ReadAllBytes(image.GetProperty("thumbnail_file").GetString()!);
        Require(thumbnail.Length >= 12 && thumbnail.AsSpan(0, 4).SequenceEqual("RIFF"u8) &&
            thumbnail.AsSpan(8, 4).SequenceEqual("WEBP"u8) && image.GetProperty("thumbnail_width").GetInt32() == 4 &&
            image.GetProperty("thumbnail_height").GetInt32() == 2,
            "Thumbnail dimensions did not honor the aspect ratio and cap.");
    }

    string firstThumbnail = images[1].GetProperty("thumbnail_file").GetString()!;
    string firstEmbedded = images[1].GetProperty("embedded_file").GetString()!;
    byte[] firstThumbnailBytes = File.ReadAllBytes(firstThumbnail);
    JsonElement repeated = One(await Query(["export-image", "--id", inlineId, "--max-resolution", "4",
        "--output-dir", destination]), "images");
    string nextThumbnail = repeated.GetProperty("thumbnail_file").GetString()!;
    string nextEmbedded = repeated.GetProperty("embedded_file").GetString()!;
    Require(nextThumbnail != firstThumbnail && nextEmbedded != firstEmbedded &&
        File.Exists(nextThumbnail) && File.Exists(nextEmbedded) &&
        File.ReadAllBytes(firstThumbnail).AsSpan().SequenceEqual(firstThumbnailBytes) &&
        File.ReadAllBytes(firstEmbedded).AsSpan().SequenceEqual(imageBytes),
        "Repeating an export reused or changed previous output files.");

    JsonElement audio = await Query(["export-audio", "--id", "-", "--output-dir", destination], audioId + "\n");
    Require(File.ReadAllBytes(One(audio, "attachments").GetProperty("audio_file").GetString()!).AsSpan().SequenceEqual(audioBytes),
        "Export changed the inline audio bytes.");
}

async Task WithoutImagingLibrary()
{
    const string Marker = "standalone media marker";
    string standalone = Path.Combine(Directory.CreateDirectory(Path.Combine(home, "standalone")).FullName,
        Path.GetFileName(cli));
    File.Copy(cli, standalone);
    Seed(Message(Marker, Image(RawImageUrl)));

    JsonElement hit = One(await Query(["search", Marker], executable: standalone), "items");
    Require(hit.GetProperty("text").GetString() == Marker, "Search failed without the imaging DLL.");
    JsonElement catalog = await Query(["images"], executable: standalone);
    string imageId = One(catalog, "items").GetProperty("image_id").GetString()!;
    JsonElement original = One(await Query(["export-image", "--id", imageId, "--original",
        "--output-dir", Path.Combine(home, "standalone-original")], executable: standalone), "images");
    string originalPath = original.GetProperty("original_file").GetString()!;
    Require(Path.GetExtension(originalPath) == ".png" && File.ReadAllBytes(originalPath).AsSpan().SequenceEqual(imageBytes),
        "Original export changed the PNG bytes or extension without the imaging DLL.");

    string destination = Path.Combine(home, "standalone-thumbnail");
    JsonElement image = One(await Query(["export-image", "--id", imageId, "--output-dir", destination],
        executable: standalone), "images");
    Require(image.TryGetProperty("export_error", out JsonElement error) &&
        error.GetString()?.Contains("Thread-Memory-Imaging.dll", StringComparison.OrdinalIgnoreCase) == true &&
        !image.TryGetProperty("thumbnail_file", out _) && !image.TryGetProperty("embedded_file", out _),
        "Missing imaging DLL did not produce a clear per-item export error.");
    Require(!Directory.Exists(destination) || !Directory.EnumerateFiles(destination).Any(),
        "Missing imaging DLL left a partial export file.");
}

static string[] Ids(JsonElement catalog, string media, string identifier) => catalog.GetProperty("items").EnumerateArray()
    .Where(item => item.GetProperty("media").GetString() == media)
    .Select(item => item.GetProperty(identifier).GetString()!).ToArray();

static JsonElement One(JsonElement document, string property) => document.GetProperty(property).EnumerateArray().Single();

static void VerifyRawExport(JsonElement report, string property, string pathProperty, byte[] original)
{
    JsonElement items = report.GetProperty(property);
    Require(items.GetArrayLength() == 2 && report.GetProperty("unknown_ids").GetArrayLength() == 0,
        "Export could not resolve the two catalog IDs.");
    Require(items[0].TryGetProperty("export_error", out JsonElement error) && !string.IsNullOrEmpty(error.GetString()) &&
        !items[0].TryGetProperty(pathProperty, out _), "Malformed typed media did not report an export error.");
    Require(File.ReadAllBytes(items[1].GetProperty(pathProperty).GetString()!).AsSpan().SequenceEqual(original),
        "Raw media bytes did not match the source.");
}

void Seed(params string[] lines) => File.WriteAllLines(rollout,
    new[] { Row("session_meta", new JsonObject { ["id"] = Thread, ["cwd"] = home }) }.Concat(lines), new UTF8Encoding(false));

static string Row(string type, JsonObject payload) => new JsonObject
{
    ["type"] = type, ["timestamp"] = Time, ["payload"] = payload,
}.ToJsonString();

static string Checkpoint() => Row("compacted", new JsonObject
{
    ["window_number"] = 1, ["replacement_history"] = new JsonArray(),
});

static string Message(string text, params JsonObject[] parts) => Row("response_item", new JsonObject
{
    ["type"] = "message", ["role"] = "user",
    ["content"] = new JsonArray([new JsonObject { ["type"] = "input_text", ["text"] = text }, .. parts]),
});

static JsonObject Image(string url) => new() { ["type"] = "input_image", ["image_url"] = url };

static JsonObject Audio(string url) => new() { ["type"] = "input_audio", ["audio_url"] = url };

async Task<JsonElement> Query(string[] arguments, string? input = null, string? executable = null)
{
    CliResult result = await Invoke(arguments, input, executable);
    ExpectExit(result, 0);
    using var document = JsonDocument.Parse(result.Output);
    return document.RootElement.Clone();
}

async Task<CliResult> Invoke(string[] arguments, string? input = null, string? executable = null)
{
    var start = new ProcessStartInfo(executable ?? cli)
    {
        WorkingDirectory = home, UseShellExecute = false, CreateNoWindow = true,
        RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true,
        StandardInputEncoding = new UTF8Encoding(false),
        StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
    };
    start.Environment["CODEX_HOME"] = home;
    start.Environment["CODEX_SQLITE_HOME"] = home;
    start.Environment["CODEX_THREAD_ID"] = Thread;
    start.ArgumentList.Add(arguments[0]);
    start.ArgumentList.Add("--rollout");
    start.ArgumentList.Add(rollout);
    foreach (string argument in arguments.Skip(1))
        start.ArgumentList.Add(argument);

    using var process = Process.Start(start) ?? throw new InvalidOperationException("CLI process did not start.");
    Task<string> output = process.StandardOutput.ReadToEndAsync();
    Task<string> error = process.StandardError.ReadToEndAsync();
    if (input is not null)
        await process.StandardInput.WriteAsync(input);
    process.StandardInput.Close();
    using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(15));
    try
    {
        await process.WaitForExitAsync(deadline.Token);
    }
    catch (OperationCanceledException) when (deadline.IsCancellationRequested)
    {
        process.Kill(entireProcessTree: true);
        await process.WaitForExitAsync();
        throw new TimeoutException();
    }

    var result = new CliResult(process.ExitCode, await output, await error);
    Safe(result.Output, "CLI stdout");
    Safe(result.Error, "CLI stderr");
    return result;
}

static void ExpectExit(CliResult result, int expected)
{
    Require(result.ExitCode == expected, $"Expected exit {expected}, got {result.ExitCode}.");
    Require(expected == 0 ? result.Error.Length == 0 : result.Output.Length == 0,
        "The CLI wrote to the wrong output stream.");
}

static void ContainsRedaction(string text, string location)
{
    Safe(text, location);
    Require(text.Contains(Redacted, StringComparison.Ordinal), $"{location} omitted the redaction marker.");
}

static void Safe(string text, string location) => Require(
    !text.Contains(ImageMarker, StringComparison.Ordinal) && !text.Contains(AudioMarker, StringComparison.Ordinal) &&
    !text.Contains("/9j/4AAQSkZJRgABAQEASABIAAD", StringComparison.Ordinal),
    $"{location} contained inline media.");

static void Require(bool condition, string message)
{
    if (!condition)
        throw new VerificationException(message);
}

static string PackagedCli([CallerFilePath] string source = "") =>
    Path.Combine(Path.GetDirectoryName(source)!, "..", "bin", "Thread-Memory.exe");

sealed record CliResult(int ExitCode, string Output, string Error);

sealed class VerificationException(string message) : InvalidOperationException(message);
