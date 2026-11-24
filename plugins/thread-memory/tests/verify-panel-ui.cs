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

    await VerifyNavigationLayout(browser);
    await VerifySelectionOnRefresh(browser);
    await VerifyInheritance(browser);
    await VerifyCleanup(browser);
}

static async Task VerifyNavigationLayout(DevTools browser)
{
    await browser.Command("Emulation.setDeviceMetricsOverride", new { width = 1440, height = 860, deviceScaleFactor = 1, mobile = false });
    await browser.Evaluate("el('threads').querySelector('button').click()");
    await browser.WaitFor("""
        visible('directory') && visible('note-directory') && visible('reader') &&
        el('detail-heading').textContent === '/root' && !el('note-feedback').hidden &&
        el('detail-status').textContent.includes('no saved note') && childNotePaths().length === 2
        """, "A wide panel should open the empty /root note beside its directory and the main threads.");
    await browser.Check("""
        ['directory', 'note-directory', 'reader'].every(id => effectiveBackground(el(id)) === 'rgb(24, 24, 24)') &&
        rootPinned() && childNotePaths().join() === [fixture.ownTitle, fixture.olderTitle].join()
        """, "The directories should share the reader's dark surface, with /root first and agent paths in update order.");
    await browser.Check("""
        (() => {
          const title = el('notes-heading');
          const style = frame.contentWindow.getComputedStyle(title);
          return title.textContent === fixture.rows[1].title && title.title === title.textContent &&
            title.scrollWidth > title.clientWidth && style.whiteSpace === 'nowrap' &&
            style.textOverflow === 'ellipsis' && style.overflowX === 'hidden';
        })()
        """, "A long thread title should take one line and keep its full text available.");
    await browser.Evaluate("el('subagent-threads').querySelector('button').click()");
    await browser.WaitFor("""
        visible('note-directory') && visible('reader') && rootPinned() &&
        el('detail-heading').textContent === fixture.ownTitle && el('note').textContent.includes('Example saved note')
        """, "Opening a subagent note should retain the same directory.");
    await browser.Evaluate("el('subagent-search').value = 'no match'; el('subagent-search').dispatchEvent(new Event('input'))");
    await browser.WaitFor("fixture.childQuery === 'no match' && childNotePaths().length === 0 && rootPinned()",
        "A search that excludes every subagent should keep /root available.");
    await browser.Evaluate("el('root-note').click()");
    await browser.WaitFor("""
        el('detail-heading').textContent === '/root' && el('detail-status').textContent.includes('no saved note') &&
        !visible('note-last-read')
        """, "Clicking an empty /root should open the main note without the previous note's read time.");
    await browser.Evaluate("el('subagent-search').value = ''; el('subagent-search').dispatchEvent(new Event('input'))");
    await browser.WaitFor("childNotePaths().length === 2", "Clearing the search should restore the subagent notes.");

    await browser.Evaluate("""
        fixture.extraChildren = 48;
        send({method:'ui/notifications/host-context-changed', params:{displayMode:'fullscreen'}});
        el('refresh').click();
        """);
    await browser.WaitFor("frame.contentDocument.documentElement.dataset.display === 'fullscreen' && el('subagent-page').textContent === 'Page 1 of 2'",
        "The full note directory should open in fullscreen.");
    await browser.Check("""
        (() => {
          const notes = el('subagent-threads');
          notes.scrollTop = 120;
          const before = notes.scrollTop;
          el('threads').querySelector('button').click();
          return before > 0 && notes.scrollTop === before;
        })()
        """, "Clicking the already selected main thread should keep the note directory's scroll position.");
    await browser.Evaluate("el('subagent-threads').scrollTop = 0");
    await browser.Command("Emulation.setDeviceMetricsOverride", new { width = 480, height = 320, deviceScaleFactor = 1, mobile = false });
    await browser.WaitFor("visible('back-to-threads') && !visible('directory') && visible('note-directory') && visible('reader')",
        "A narrow panel should keep the note directory and the reader together, with a way back to main threads.");
    await browser.Evaluate("el('subagent-threads').querySelector('button').click()");
    await browser.WaitFor("""
        visible('note-directory') && visible('reader') && rootPinned() &&
        el('detail-heading').textContent === fixture.ownTitle && el('note').textContent.includes('Example saved note')
        """,
        "Opening an agent note on a narrow panel should leave the common directory and /root available.");
    await browser.Check("el('note').getBoundingClientRect().bottom <= el('reader-body').getBoundingClientRect().bottom",
        "The saved note should fit in its reader even in a short fullscreen panel with a full directory.");
    await browser.Evaluate("el('back-to-threads').click()");
    await browser.WaitFor("visible('directory') && !visible('note-directory') && !visible('reader')",
        "Narrow navigation should return to the main thread directory.");
    await browser.Command("Emulation.setDeviceMetricsOverride", new { width = 1440, height = 860, deviceScaleFactor = 1, mobile = false });
    await browser.WaitFor("visible('directory') && visible('note-directory') && visible('reader')",
        "The wide layout should restore the directories and reader.");
    await browser.Evaluate("""
        fixture.extraChildren = 0;
        send({method:'ui/notifications/host-context-changed', params:{displayMode:'inline'}});
        el('refresh').click();
        """);
    await browser.WaitFor("childNotePaths().length === 2 && el('refresh').getAttribute('aria-disabled') === 'false'",
        "Leaving fullscreen should restore the ordinary note directory.");
}

static async Task VerifySelectionOnRefresh(DevTools browser)
{
    await browser.Evaluate("el('subagent-threads').querySelector('button').click()");
    await browser.WaitFor("el('detail-heading').textContent === fixture.ownTitle && el('note').textContent.includes('Example saved note')",
        "The selected child note should be ready for the refresh test.");
    await browser.Check("""
        visible('note-last-read') &&
        el('note-last-read').textContent === 'Last read ' + new frame.contentWindow.Intl.RelativeTimeFormat(undefined, {numeric:'always'}).format(-2, 'minute') &&
        el('note-last-read').dateTime === fixture.lastReadAt && el('note-last-read').title.includes(fixture.lastReadAt) &&
        el('note-date').textContent.startsWith('Last updated ')
        """, "The reader should show the note's read age, exact timestamp and separate update time.");
    await browser.Evaluate("fixture.ownChildAvailability = null; el('refresh').click()");
    await browser.WaitFor("fixture.lastRead === ownChild.thread_id && el('refresh').getAttribute('aria-disabled') === 'false'",
        "The selected child should be rechecked during refresh.");
    await browser.Check("""
        el('detail-heading').textContent === fixture.ownTitle && el('note').textContent.includes('Example saved note') &&
        el('detail-status').textContent.includes('Showing the last loaded note')
        """, "An inconclusive note read should keep the selected child and its last loaded text.");
    await browser.Evaluate("fixture.ownChildAvailability = false; el('refresh').click()");
    await browser.WaitFor("""
        el('detail-heading').textContent === '/root' && el('detail-status').textContent.includes('no saved note') &&
        !childNotePaths().includes(fixture.ownTitle) && el('refresh').getAttribute('aria-disabled') === 'false'
        """, "A successful read of a vanished child note should fall back to /root.");

    await browser.Evaluate("fixture.ownChildAvailability = true; fixture.hiddenMainAvailability = null; el('refresh').click()");
    await browser.WaitFor("el('threads').querySelectorAll('button').length === 0 && el('refresh').getAttribute('aria-disabled') === 'false'",
        "The selected main thread should be absent from the visible list during an inconclusive refresh.");
    await browser.Check("""
        visible('note-directory') && visible('reader-body') && el('detail-heading').textContent === '/root' &&
        fixture.lists.at(-1).selected_thread_id === fixture.secondId
        """, "A refresh without definitive main thread availability should keep the selected thread.");

    await browser.Evaluate("fixture.hiddenMainAvailability = false; el('refresh').click()");
    await browser.WaitFor("!visible('note-directory') && !visible('reader-body') && el('refresh').getAttribute('aria-disabled') === 'false'",
        "Only a definitive missing result should clear a disappeared main thread.");
    await browser.Evaluate("fixture.hiddenMainAvailability = undefined; el('refresh').click()");
    await browser.WaitFor("el('threads').querySelectorAll('button').length === 1 && el('refresh').getAttribute('aria-disabled') === 'false'",
        "Restored thread results should be visible again.");
}

static async Task VerifyInheritance(DevTools browser)
{
    await browser.Evaluate("el('threads').querySelector('button').click()");
    await browser.WaitFor("!el('include-inherited-control').hidden && childNotePaths().length === 2",
        "A fork should offer inherited notes while showing its own notes by default.");
    await browser.Evaluate("el('include-inherited').click()");
    await browser.WaitFor("childNotePaths().length === 3",
        "Checking the inheritance filter should list the saved snapshot.");
    await browser.Evaluate("el('subagent-threads').querySelector('button').click()");
    await browser.WaitFor("visible('note-last-read')", "The current child note should show its read time before changing notes.");
    await browser.Evaluate("""el('subagent-threads').querySelector('[data-thread="' + fixture.inheritedId + '"]').click()""");
    await browser.WaitFor("!el('note-inherited').hidden && el('note').textContent.includes('Example fork snapshot') && !visible('note-last-read')",
        "An inherited snapshot should display its saved note without a read time.");

    await browser.Evaluate("fixture.inheritance = 'unavailable'; el('refresh').click()");
    await browser.WaitFor("""
        !el('subagent-status').hidden && el('subagent-status').textContent.includes('Could not verify the fork history') &&
        el('detail-status').textContent.includes('Showing the last loaded note')
        """, "A transient fork read failure should warn about both the directory and snapshot.");
    await browser.Check("""
        !el('include-inherited-control').hidden && el('include-inherited').checked &&
        childNotePaths().length === 3 &&
        !el('note-inherited').hidden && el('note').textContent.includes('Example fork snapshot')
        """, "An unavailable fork should retain its filter, previously loaded directory and selected note.");

    await browser.WaitFor("el('refresh').getAttribute('aria-disabled') === 'false'", "The fork refresh should settle.");
    await browser.Evaluate("fixture.inheritance = 'partial'; el('refresh').click()");
    await browser.WaitFor("""
        el('subagent-status').textContent.includes('Some inherited notes') &&
        childNotePaths().length === 2 &&
        el('refresh').getAttribute('aria-disabled') === 'false'
        """, "A partial result should show verified notes with a warning.");
    await browser.Check("el('include-inherited').checked && el('note').textContent.includes('Example fork snapshot')",
        "A partial result should keep the filter and the selected snapshot.");

    await browser.Evaluate("fixture.inheritance = 'available'; el('refresh').click()");
    await browser.WaitFor("""
        el('subagent-status').hidden && el('note-feedback').hidden && el('include-inherited').checked &&
        childNotePaths().length === 3 &&
        el('refresh').getAttribute('aria-disabled') === 'false'
        """, "A successful retry should restore the complete directory and clear the temporary warnings.");

    await browser.Evaluate("fixture.extraChildren = 48; el('refresh').click()");
    await browser.WaitFor("el('subagent-page').textContent === 'Page 1 of 3' && el('refresh').getAttribute('aria-disabled') === 'false'",
        "The complete inherited directory should have three pages.");
    await browser.Evaluate("el('subagent-next').click()");
    await browser.WaitFor("el('subagent-page').textContent === 'Page 2 of 3' && el('subagent-next').getAttribute('aria-disabled') === 'false'",
        "The second subagent page should load.");
    await browser.Evaluate("el('subagent-next').click()");
    await browser.WaitFor("""
        el('subagent-page').textContent === 'Page 3 of 3' &&
        el('subagent-threads').querySelector('button')?.dataset.thread === fixture.inheritedId &&
        el('refresh').getAttribute('aria-disabled') === 'false' && rootPinned()
        """, "The third subagent page should show the inherited snapshot below /root.");
    await browser.Evaluate("fixture.inheritance = 'partial'; el('refresh').click()");
    await browser.WaitFor("""
        !el('subagent-status').hidden && el('subagent-status').textContent.includes('Some inherited notes') &&
        el('refresh').getAttribute('aria-disabled') === 'false'
        """, "The partial refresh should warn that the inheritance view is incomplete.");
    await browser.Check("""
        el('subagent-page').textContent === 'Page 3 of 3' &&
        el('subagent-threads').querySelector('button')?.dataset.thread === fixture.inheritedId
        """, "A temporarily clamped result should keep the cached third page.");
    await browser.Evaluate("fixture.inheritance = 'available'; el('refresh').click()");
    await browser.WaitFor("""
        fixture.requestedChildPage === 3 && el('subagent-status').hidden &&
        el('subagent-page').textContent === 'Page 3 of 3'
        """, "Recovery should request the preserved page and clear the warning.");

    await browser.Evaluate("fixture.noteStoreAvailable = false; el('refresh').click()");
    await browser.WaitFor("""
        visible('status') && visible('subagent-status') && visible('note-feedback') &&
        el('refresh').getAttribute('aria-disabled') === 'false'
        """, "The thread and note directories should report temporarily unavailable storage.");
    await browser.Check("""
        el('threads').querySelector('button')?.dataset.thread === fixture.secondId && el('archive-status').value === 'active' &&
        el('subagent-page').textContent === 'Page 3 of 3' && el('include-inherited').checked &&
        el('subagent-threads').querySelector('button')?.dataset.thread === fixture.inheritedId &&
        el('note').textContent.includes('Example fork snapshot')
        """, "An unavailable note store should retain the loaded directories, filters, child page and note text.");
    await browser.Evaluate("fixture.noteStoreAvailable = true; el('refresh').click()");
    await browser.WaitFor("""
        !visible('status') && !visible('subagent-status') && !visible('note-feedback') &&
        el('refresh').getAttribute('aria-disabled') === 'false' && fixture.requestedChildPage === 3 &&
        el('threads').querySelector('button')?.dataset.thread === fixture.secondId &&
        el('subagent-threads').querySelector('button')?.dataset.thread === fixture.inheritedId
        """, "A successful refresh should reload the retained page and clear the storage warnings.");
}

static async Task VerifyCleanup(DevTools browser)
{
    await browser.Evaluate("controlPanelTimers()");
    await browser.Evaluate("el('manage').click(); el('check-cleanup').click()");
    await browser.WaitFor("fixture.previews.length === 1", "The first cleanup preview should reach the host.");
    await browser.Evaluate("advancePanelTimers(24000); el('close-manager').click(); el('manage').click(); el('check-cleanup').click()");
    await browser.WaitFor("fixture.previews.length === 2", "Reopening Manage should allow a new cleanup preview.");
    await browser.Evaluate("advancePanelTimers(1000); fixture.previews[0]({status:'ok', thread_ids:[fixture.firstId]}); postBarrier()");
    await browser.WaitFor("fixture.barrierReached", "The iframe should process the stale cleanup response.");
    await browser.Check("""
        el('management-dialog').open && !el('cleanup-dialog').open &&
        !el('cleanup-status').textContent.startsWith('Still checking') && el('check-cleanup').disabled
        """, "A closed preview must not open a confirmation or change the new preview's progress.");
    await browser.Evaluate("advancePanelTimers(24000)");
    await browser.WaitFor("el('cleanup-status').textContent.startsWith('Still checking') && el('check-cleanup').disabled",
        "A cleanup preview still running after the usual deadline should show progress and stay pending.");
    await browser.Evaluate("fixture.previews[1]({status:'ok', thread_ids:fixture.cleanupCandidates})");
    await browser.WaitFor("""el('cleanup-dialog').open && el('missing-threads').textContent === fixture.cleanupCandidates.join('\n')""",
        "A slow current preview should still offer its candidates for confirmation.");

    await browser.Evaluate("el('delete-cleanup').click()");
    await browser.WaitFor("fixture.deletion", "The confirmed deletion should reach the host.");
    await browser.Check("fixture.deletion.ids.join() === fixture.cleanupCandidates.join()",
        "The confirmed deletion should use only the current preview's candidates.");
    await browser.Evaluate("advancePanelTimers(25000)");
    await browser.WaitFor("el('cleanup-status').textContent.startsWith('Still deleting') && el('check-cleanup').disabled",
        "A deletion still running after the usual deadline should show progress and stay pending.");
    await browser.Evaluate("el('close-manager').click()");
    await browser.Check("!el('cleanup-page-status').hidden && el('cleanup-page-status').textContent.startsWith('Still deleting')",
        "Cleanup should remain visible after closing Manage.");
    await browser.Evaluate("""
        fixture.rows.splice(1, 1);
        fixture.deletion.finish({status:'ok', thread_ids:[fixture.secondId], deleted:1,
          kept_thread_ids:[fixture.cleanupCandidates[1]], skipped_thread_count:1, reason:'Fork copy could not be verified.'});
        """);
    await browser.WaitFor("""
        el('cleanup-page-status').textContent.includes('Deleted 1') &&
        el('cleanup-page-status').textContent.includes('Kept data for 1 thread that is still present.') &&
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
        const visible = id => {
          const node = el(id);
          return node?.getClientRects().length > 0 && frame.contentWindow.getComputedStyle(node).visibility === 'visible';
        };
        const childNotePaths = () => Array.from(el('subagent-threads').querySelectorAll('button .label'), label => label.textContent);
        const rootPinned = () => {
          const firstChild = el('subagent-threads').querySelector('button');
          return visible('root-note') && el('root-note').querySelector('.label')?.textContent === '/root' &&
            (!firstChild || el('root-note').getBoundingClientRect().bottom <= firstChild.getBoundingClientRect().top);
        };
        function effectiveBackground(node) {
          while (node) {
            const color = frame.contentWindow.getComputedStyle(node).backgroundColor;
            if (color !== 'rgba(0, 0, 0, 0)') return color;
            node = node.parentElement;
          }
        }
        const firstId = '00000000-0000-4000-8000-000000000001';
        const secondId = '00000000-0000-4000-8000-000000000002';
        const rows = [firstId, secondId].map((thread_id, i) => ({
          thread_id, title: i === 0 ? 'Thread 1' : 'Thread 2 with a long title '.repeat(8).trim(),
          archived:false, latest_at:'2026-11-24T08:29:00Z'
        }));
        const inheritedId = '00000000-0000-4000-8000-000000000003';
        const ownTitle = '/root/principal_language';
        const olderTitle = '/root/archived_worker';
        const ownChild = {...rows[1], thread_id:'00000000-0000-4000-8000-000000000004', title:ownTitle};
        const olderChild = {...ownChild, thread_id:'00000000-0000-4000-8000-000000000007',
          latest_at:'2026-11-23T08:29:00Z', title:olderTitle};
        const inheritedChild = {...rows[1], thread_id:inheritedId, latest_at:'2026-11-21T08:29:00Z',
          title:'/root/inherited_context', inherited:true};
        const cleanupCandidates = [secondId, '00000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000006'];
        const fixture = { firstId, secondId, inheritedId, ownTitle, olderTitle, rows, cleanupCandidates,
          lastReadAt:new Date(Date.now() - 120000).toISOString(),
          initializations:0, lists:[], previews:[], inheritance:'available', extraChildren:0,
          ownChildAvailability:true, noteStoreAvailable:true };
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
            else reply({hostContext:{theme:'dark', styles:{variables:{
              '--color-background-primary':'#181818', '--color-background-secondary':'#383838'
            }}}});
          } else if (method === 'tools/call') {
            const args = params.arguments;
            switch (params.name) {
              case 'handoff_list': {
                fixture.lists.push(args);
                if (!fixture.noteStoreAvailable) {
                  tool({items:[], total:0, page:1, total_pages:1, selected_available:null, note_store_available:false});
                  break;
                }
                const hideSelected = fixture.hiddenMainAvailability !== undefined;
                const items = rows.filter(row => (!hideSelected || row.thread_id !== args.selected_thread_id) &&
                  (args.archive_status === 'all' || row.archived === (args.archive_status === 'archived')));
                const selected = rows.find(row => row.thread_id === args.selected_thread_id);
                tool({items, total:items.length, page:1, total_pages:1,
                  selected_available:hideSelected ? fixture.hiddenMainAvailability : args.selected_thread_id ? Boolean(selected) : null,
                  selected_archived:hideSelected ? null : selected?.archived, note_store_available:true});
                break;
              }
              case 'handoff_children': {
                fixture.requestedChildPage = args.page;
                fixture.childQuery = args.query;
                if (!fixture.noteStoreAvailable) {
                  tool({items:[], total:0, page:1, total_pages:1, spawn_index_available:true,
                    can_include_inherited:true, inheritance_status:'available', note_store_available:false});
                  break;
                }
                const candidates = [ownChild, olderChild, ...Array.from({length:fixture.extraChildren}, (_, i) => ({
                  ...ownChild, thread_id:'00000000-0000-4000-8000-' + String(i + 100).padStart(12, '0'),
                  latest_at:'2026-11-22T08:29:00Z', title:'/root/archived_' + (i + 1), archived:true
                }))];
                if (args.include_inherited && fixture.inheritance === 'available') candidates.push(inheritedChild);
                const matches = candidates.filter(row => (fixture.ownChildAvailability !== false || row !== ownChild) &&
                  (!args.query || [row.title, row.thread_id].some(value => value.toLowerCase().includes(args.query.toLowerCase()))));
                const total_pages = Math.max(1, Math.ceil(matches.length / args.limit));
                const page = Math.min(args.page, total_pages);
                const items = matches.slice((page - 1) * args.limit, page * args.limit);
                tool({items, total:matches.length, page, total_pages, spawn_index_available:true, note_store_available:true,
                  can_include_inherited:fixture.inheritance !== 'unavailable', inheritance_status:fixture.inheritance});
                break;
              }
              case 'handoff_read':
                fixture.lastRead = args.thread_id;
                if (!fixture.noteStoreAvailable) {
                  tool({summary:null, updated_at:null, last_read_at:null, note_available:null});
                } else if (args.from_fork === secondId && args.thread_id === inheritedId) {
                  if (fixture.inheritance === 'available') tool({summary:'Example fork snapshot', updated_at:'2026-11-24T08:29:00Z', last_read_at:null, note_available:true});
                  else reply({isError:true, content:[{type:'text', text:'Could not verify the fork history.'}]});
                } else if (args.thread_id === ownChild.thread_id && fixture.ownChildAvailability !== true) {
                  tool({summary:null, updated_at:null, last_read_at:null, note_available:fixture.ownChildAvailability});
                } else if (args.thread_id === secondId) {
                  tool({summary:null, updated_at:null, last_read_at:null, note_available:false});
                } else tool({summary:'Example saved note', updated_at:'2026-11-24T08:29:00Z',
                  last_read_at:args.thread_id === ownChild.thread_id ? fixture.lastReadAt : null, note_available:true});
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
        let panelTime = 0;
        function controlPanelTimers() {
          const panel = frame.contentWindow;
          const schedule = panel.setTimeout.bind(panel);
          const cancel = panel.clearTimeout.bind(panel);
          panel.setTimeout = (callback, delay, ...args) => {
            if (delay < 25000) return schedule(callback, delay, ...args);
            const token = schedule(() => {}, 2147483647);
            panelTimers.set(token, {deadline:panelTime + delay, run:() => callback(...args)});
            return token;
          };
          panel.clearTimeout = token => {
            panelTimers.delete(token);
            cancel(token);
          };
        }
        function advancePanelTimers(elapsed) {
          panelTime += elapsed;
          const due = [...panelTimers].filter(([, timer]) => timer.deadline <= panelTime)
            .sort(([, left], [, right]) => left.deadline - right.deadline);
          for (const [token, timer] of due) {
            if (!panelTimers.has(token)) continue;
            frame.contentWindow.clearTimeout(token);
            timer.run();
          }
        }
        frame.src = '/panel';
        document.body.append(frame);
        </script>
        """;
}
