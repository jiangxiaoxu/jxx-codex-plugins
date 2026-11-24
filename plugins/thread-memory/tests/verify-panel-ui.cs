#:sdk Microsoft.NET.Sdk.Web
#:property PublishAot=false

using System.Diagnostics;
using System.Net.WebSockets;
using System.Runtime.CompilerServices;
using System.Text.Json;

if (args.Length > 2)
{
    Console.Error.WriteLine("Usage: dotnet run --file verify-panel-ui.cs -- [chromium.exe] [panel.html]");
    return 2;
}

try
{
    string browserPath = args.Length > 0 ? Path.GetFullPath(args[0]) : FindBrowser();
    string panelPath = args.Length > 1 ? Path.GetFullPath(args[1]) : DefaultPanelPath();
    string panel = await File.ReadAllTextAsync(panelPath);
    var builder = WebApplication.CreateSlimBuilder([]);
    builder.Logging.ClearProviders();
    await using var web = builder.Build();
    web.Urls.Add("http://127.0.0.1:0");
    web.MapGet("/", () => Results.Content(HostFixture.Html, "text/html; charset=utf-8"));
    web.MapGet("/panel", () => Results.Content(panel, "text/html; charset=utf-8"));
    await web.StartAsync();

    var profile = Directory.CreateTempSubdirectory("thread-memory-ui-");
    try
    {
        var launch = new ProcessStartInfo(browserPath) { UseShellExecute = false, CreateNoWindow = true };
        foreach (string flag in new[] { "--headless", "--disable-gpu", "--disable-extensions", "--disable-background-networking",
            "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0",
            "--user-data-dir=" + profile.FullName, "--window-size=1200,800", "about:blank" })
            launch.ArgumentList.Add(flag);

        using var browser = Process.Start(launch) ?? throw new InvalidOperationException("Could not start Chromium.");
        try
        {
            using var startup = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            string portFile = Path.Combine(profile.FullName, "DevToolsActivePort");
            string? port = null;
            while (port is null)
            {
                if (browser.HasExited) throw new InvalidOperationException("Chromium exited before opening DevTools.");
                if (File.Exists(portFile))
                    port = (await File.ReadAllLinesAsync(portFile, startup.Token)).FirstOrDefault();
                if (port is null) await Task.Delay(25, startup.Token);
            }
            using var http = new HttpClient(new HttpClientHandler { UseProxy = false });
            using var targets = JsonDocument.Parse(await http.GetStringAsync($"http://127.0.0.1:{port}/json/list", startup.Token));
            var target = targets.RootElement.EnumerateArray().Single(item => item.GetProperty("type").GetString() == "page");
            using var devTools = new DevTools();
            await devTools.Connect(new Uri(target.GetProperty("webSocketDebuggerUrl").GetString()!), startup.Token);
            await devTools.Command("Page.navigate", new { url = web.Urls.Single() });
            await VerifyUi(devTools);
            Console.WriteLine("Thread Memory browser checks passed.");
        }
        finally
        {
            if (!browser.HasExited)
            {
                browser.Kill(entireProcessTree: true);
                using var shutdown = new CancellationTokenSource(TimeSpan.FromSeconds(10));
                await browser.WaitForExitAsync(shutdown.Token);
            }
        }
    }
    finally
    {
        for (int attempt = 0; ; attempt++)
        {
            try { profile.Delete(recursive: true); break; }
            catch (IOException) when (attempt < 20) { await Task.Delay(50); }
        }
    }
    return 0;
}
catch (Exception error)
{
    Console.Error.WriteLine(error.Message);
    return 1;
}

static async Task VerifyUi(DevTools browser)
{
    await browser.WaitFor("typeof el === 'function' && el('retry-connection')?.hidden === false && el('refresh').disabled",
        "A failed initialization should offer a connection retry.");
    await browser.Evaluate("el('retry-connection').click(); el('retry-connection').click()");
    await browser.WaitFor("el('retry-connection').hidden && !el('refresh').disabled && el('threads').querySelectorAll('button').length === 2",
        "A single retry should load the thread directory.");
    await browser.Check("fixture.initializations === 2", "Retry should issue one additional MCP initialization.");

    await browser.Evaluate("el('archive-status').value = 'active'; el('archive-status').dispatchEvent(new Event('change'))");
    await browser.WaitFor("fixture.lists.at(-1)?.archive_status === 'active' && el('threads').getAttribute('aria-busy') === 'false'",
        "The active-only thread filter should load.");
    await browser.Evaluate("el('threads').querySelector('button').click()");
    await browser.WaitFor("!el('reader-body').hidden && el('note').textContent.includes('Example saved note')",
        "The selected thread note should load.");
    await browser.Evaluate("fixture.rows[0].archived = true; el('refresh').click()");
    await browser.WaitFor("el('threads').querySelectorAll('button').length === 1 && el('reader-body').hidden",
        "Refresh should clear a selection that has just left the active filter.");
    await browser.Check("fixture.lists.at(-1).selected_thread_id === fixture.firstId",
        "Refresh should verify the selected thread even when it is no longer listed.");

    await browser.Evaluate("el('manage').click(); el('check-cleanup').click()");
    await browser.WaitFor("fixture.previews.length === 1", "The first cleanup preview should reach the host.");
    await browser.Evaluate("el('close-manager').click(); el('manage').click(); el('check-cleanup').click()");
    await browser.WaitFor("fixture.previews.length === 2", "Reopening Manage should allow a new cleanup preview.");
    await browser.Evaluate("fixture.previews[0]({status:'ok', thread_ids:[fixture.firstId]}); postBarrier()");
    await browser.WaitFor("fixture.barrierReached", "The iframe should process the stale cleanup response.");
    await browser.Check("el('management-dialog').open && !el('cleanup-dialog').open",
        "A preview from the previously closed dialog must never open a confirmation.");
    await browser.Evaluate("fixture.previews[1]({status:'ok', thread_ids:[fixture.secondId]})");
    await browser.WaitFor("el('cleanup-dialog').open && el('missing-threads').textContent === fixture.secondId",
        "Only the current preview should be offered for confirmation.");

    await browser.Evaluate("controlPanelTimers(); el('delete-cleanup').click()");
    await browser.WaitFor("fixture.deletion", "The confirmed deletion should reach the host.");
    await browser.Check("fixture.deletion.ids.length === 1 && fixture.deletion.ids[0] === fixture.secondId",
        "Only the current preview's thread should be deleted.");
    await browser.Evaluate("advancePanelTimers(25000)");
    await browser.WaitFor("el('cleanup-status').textContent.startsWith('Still deleting') && el('check-cleanup').disabled",
        "A deletion still running after the usual deadline should show progress and stay pending.");
    await browser.Evaluate("el('close-manager').click()");
    await browser.Check("!el('cleanup-page-status').hidden && el('cleanup-page-status').textContent.startsWith('Still deleting')",
        "Cleanup should remain visible after closing Manage.");
    await browser.Evaluate("""
        fixture.rows.splice(1, 1);
        fixture.deletion.finish({status:'ok', thread_ids:[fixture.secondId], deleted:1,
          kept_thread_ids:[fixture.firstId], reason:'Fork copy could not be verified.'});
        """);
    await browser.WaitFor("""
        el('cleanup-page-status').textContent.includes('Deleted 1') &&
        el('cleanup-page-status').textContent.includes('Kept data for 1 thread') &&
        el('cleanup-page-status').textContent.includes('Fork copy could not be verified.') &&
        !el('threads').querySelector('button') && !el('check-cleanup').disabled
        """, "A late cleanup result should show the partial-success warning and refresh the directory.");
}

static string FindBrowser()
{
    foreach (var (folder, relativePath) in new[]
    {
        (Environment.SpecialFolder.ProgramFiles, @"Google\Chrome\Application\chrome.exe"),
        (Environment.SpecialFolder.ProgramFilesX86, @"Google\Chrome\Application\chrome.exe"),
        (Environment.SpecialFolder.LocalApplicationData, @"Google\Chrome\Application\chrome.exe"),
        (Environment.SpecialFolder.ProgramFilesX86, @"Microsoft\Edge\Application\msedge.exe"),
        (Environment.SpecialFolder.ProgramFiles, @"Microsoft\Edge\Application\msedge.exe"),
    })
    {
        string path = Path.Combine(Environment.GetFolderPath(folder), relativePath);
        if (File.Exists(path)) return path;
    }
    throw new FileNotFoundException("Chrome or Edge was not found. Pass its executable path after --.");
}

static string DefaultPanelPath([CallerFilePath] string path = "") =>
    Path.Combine(Directory.GetParent(Path.GetDirectoryName(path)!)!.FullName,
        "skills", "thread-memory", "assets", "handoffs.html");

sealed class DevTools : IDisposable
{
    private readonly ClientWebSocket socket = new();
    private int id;

    public Task Connect(Uri url, CancellationToken token) => socket.ConnectAsync(url, token);

    public async Task<JsonElement> Command(string method, object parameters)
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        int requestId = ++id;
        await socket.SendAsync(JsonSerializer.SerializeToUtf8Bytes(new { id = requestId, method, @params = parameters }),
            WebSocketMessageType.Text, true, deadline.Token);
        byte[] buffer = new byte[8192];
        while (true)
        {
            using var data = new MemoryStream();
            ValueWebSocketReceiveResult received;
            do
            {
                received = await socket.ReceiveAsync(buffer.AsMemory(), deadline.Token);
                if (received.MessageType == WebSocketMessageType.Close) throw new IOException("Chromium closed DevTools.");
                data.Write(buffer, 0, received.Count);
            } while (!received.EndOfMessage);
            data.Position = 0;
            using var parsed = await JsonDocument.ParseAsync(data, cancellationToken: deadline.Token);
            var message = parsed.RootElement;
            if (!message.TryGetProperty("id", out var reply) || reply.GetInt32() != requestId) continue;
            if (message.TryGetProperty("error", out var error)) throw new InvalidOperationException(error.ToString());
            return message.GetProperty("result").Clone();
        }
    }

    public async Task<JsonElement> Evaluate(string expression)
    {
        var evaluation = await Command("Runtime.evaluate", new { expression, returnByValue = true });
        if (evaluation.TryGetProperty("exceptionDetails", out var error))
            throw new InvalidOperationException(error.GetProperty("exception").GetProperty("description").GetString());
        return evaluation.GetProperty("result").TryGetProperty("value", out var value) ? value : default;
    }

    public async Task WaitFor(string expression, string failure)
    {
        var elapsed = Stopwatch.StartNew();
        do
        {
            if ((await Evaluate($"Boolean({expression})")).GetBoolean()) return;
            await Task.Delay(25);
        } while (elapsed.Elapsed < TimeSpan.FromSeconds(5));
        throw new InvalidOperationException(failure);
    }

    public async Task Check(string expression, string failure)
    {
        if (!(await Evaluate($"Boolean({expression})")).GetBoolean()) throw new InvalidOperationException(failure);
    }

    public void Dispose() => socket.Dispose();
}

static class HostFixture
{
    public const string Html = """
        <!doctype html>
        <meta charset="utf-8">
        <title>Thread Memory UI test</title>
        <style>body{margin:0}iframe{display:block;width:100vw;height:100vh;border:0}</style>
        <body>
        <script>
        const frame = document.createElement('iframe');
        const el = id => frame.contentDocument?.getElementById(id);
        const firstId = '00000000-0000-4000-8000-000000000001';
        const secondId = '00000000-0000-4000-8000-000000000002';
        const rows = [firstId, secondId].map((thread_id, i) => ({
          thread_id, title: 'Thread ' + (i + 1), archived:false, latest_at:'2026-11-24T08:29:00Z'
        }));
        const fixture = { firstId, secondId, rows, initializations:0, lists:[], previews:[] };
        const send = fields => frame.contentWindow.postMessage({jsonrpc:'2.0', ...fields}, '*');
        function postBarrier() { send({id:'test-barrier', method:'ping'}); }
        addEventListener('message', ({source, data}) => {
          if (source !== frame.contentWindow || data?.jsonrpc !== '2.0' || !data.id) return;
          const {id, method, params} = data;
          const reply = result => send({id, result});
          const tool = structuredContent => reply({structuredContent});
          if (id === 'test-barrier') {
            fixture.barrierReached = true;
          } else if (method === 'ui/initialize') {
            if (++fixture.initializations === 1) send({id, error:{code:-32603, message:'Temporary bridge failure'}});
            else reply({hostContext:{theme:'dark'}});
          } else if (method === 'tools/call') {
            const args = params.arguments;
            switch (params.name) {
              case 'handoff_list': {
                fixture.lists.push(args);
                const items = rows.filter(row => args.archive_status === 'all' || row.archived === (args.archive_status === 'archived'));
                const selected = rows.find(row => row.thread_id === args.selected_thread_id);
                tool({items, total:items.length, page:1, total_pages:1, selected_archived:selected?.archived});
                break;
              }
              case 'handoff_read':
                tool({summary:'Example saved note', updated_at:'2026-11-24T08:29:00Z'});
                break;
              case 'handoff_cleanup':
                if (args.thread_ids) fixture.deletion = {ids:args.thread_ids, finish:tool};
                else fixture.previews.push(tool);
                break;
            }
          }
        });

        // Drive the ordinary request deadline without advancing visibility or UI timers.
        const panelTimers = new Map();
        function controlPanelTimers() {
          const panel = frame.contentWindow;
          const schedule = panel.setTimeout.bind(panel);
          const cancel = panel.clearTimeout.bind(panel);
          panel.setTimeout = (callback, delay, ...args) => {
            if (delay < 25000) return schedule(callback, delay, ...args);
            const token = schedule(() => {}, 2147483647);
            panelTimers.set(token, {delay, run:() => callback(...args)});
            return token;
          };
          panel.clearTimeout = token => {
            panelTimers.delete(token);
            cancel(token);
          };
        }
        function advancePanelTimers(elapsed) {
          for (const [token, timer] of panelTimers) {
            if (timer.delay > elapsed) continue;
            frame.contentWindow.clearTimeout(token);
            timer.run();
          }
        }
        frame.src = '/panel';
        document.body.append(frame);
        </script>
        """;
}
