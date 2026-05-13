---
name: rg
description: "Use when the user mentions rg, ripgrep, or asks to search files through the Node REPL helper."
---

Use `rg-client` from the Node REPL.

## Bootstrap

Run once when the skill is activated:

```js
if (typeof globalThis.rg === "undefined") {
  const { setupRgRuntime } = await import("<plugin root>/scripts/rg-client.mjs");
  setupRgRuntime({ globals: globalThis, defaultCwd: nodeRepl.cwd });
}
```

Use `globalThis` for cross-call state. Pass `rgPath` only during first registration when an explicit `rg.exe` is needed.

## API

Use only these methods. Do not invent chain methods.

- `rg`: `search(pattern)`, `files()`, `raw(args, options?)`, `show(value)`, `sessions()`, `cancelAll()`
- `SearchBuilder`: `cwd(path)`, `path(path)`, `glob(pattern)`, `type(name)`, `fixedStrings()`, `ignoreCase()`, `smartCase()`, `hidden()`, `noIgnore()`, `beforeContext(n)`, `afterContext(n)`, `next(n)`, `drain()`, `show()`, `start()`
- `FilesBuilder`: `cwd(path)`, `glob(pattern)`, `type(name)`, `hidden()`, `noIgnore()`, `next(n)`, `drain()`, `show()`, `start()`
- `SearchSession` / `FileSession`: `next(n)`, `drain()`, `show()`, `cancel()`

`rg.search(pattern)` builds a text search builder. `rg.files()` builds a file listing builder. `rg.raw(args, options?)` immediately runs low-level ripgrep arguments and returns a Promise for one raw result object. `rg.show(value)` prints an existing result, or a string message as-is.

Builders collect filters before a command starts. Use `next(n)` for one batch, `drain()` for remaining output with the built-in cap, `show()` to drain and print, and `start()` when the session must continue across calls.

Sessions represent running rg processes. Use `next(n)` to read more, `drain()` to read the remaining capped output, `show()` to display the remaining capped output, and `cancel()` when the session is no longer needed.

Return shapes:

- Search batches return `{ text, info }`.
- File batches return `{ files, stats, done, truncated, readTimedOut, stopReason }`.
- Raw calls return `{ args, cwd, exitCode, signal, stdout, stderr, timedOut, truncated, forceFinished }`.
- `rg.show(value)` returns the resolved value after writing the display text.

## Examples

Search:

```js
await rg.search("TODO").show();
await rg.search("TODO").cwd("src").glob("**/*.ts").show();
await rg.search("TODO").path("src/index.ts").show();
```

Match options:

```js
await rg.search("foo.bar(").fixedStrings().show();
await rg.search("todo").smartCase().show();
await rg.search("TODO").beforeContext(2).afterContext(2).show();
```

Files:

```js
await rg.files().glob("*.md").show();
await rg.files().type("ts").hidden().show();
await rg.show(await rg.raw(["--files", "src"]));
```

Batch control:

```js
const session = rg.search("TODO").glob("*.js").start();
await rg.show(await session.next(20));
await session.show();
```

Cross-call session, first call:

```js
if (globalThis.rgSession) {
  await globalThis.rgSession.cancel();
}

globalThis.rgSession = rg.search("TODO").glob("*.js").start();
const batch = await globalThis.rgSession.next(20);
await rg.show(batch);

if (batch.info === "done") {
  delete globalThis.rgSession;
}
```

Cross-call session, later call:

```js
const session = globalThis.rgSession;
if (!session) {
  await rg.show("No active rg session.");
} else {
  const batch = await session.next(20);
  await rg.show(batch);

  if (batch.info === "done") {
    delete globalThis.rgSession;
  }
}
```

Raw and cleanup:

```js
const version = await rg.raw(["--version"]);
await rg.show(version);

const rawSearch = await rg.raw(["TODO", "src"], { maxBytes: 32 * 1024 });
await rg.show(rawSearch);
if (rawSearch.exitCode > 1) {
  await rg.show(rawSearch.stderr);
}

await rg.show(rg.sessions());
await rg.cancelAll();
```

## Rules

- `search` uses regex by default;use `fixedStrings()` for literal text.
- Use repeated `.glob(...)` calls for multiple `-g` filters.
- `next(n)` accepts only a positive integer;do not pass object arguments or `next(-1)`.
- `drain()` / `show()` do not accept arguments;`drain()` reads up to about 16KB, and search `next()` text is capped at 12KB.
- Builder `next/drain/show` uses a temporary session and auto-`cancel()`s when the result is not fully read.
- Session `next/drain/show` continues from the current cursor and does not auto-`cancel()`;when not fully read, continue with `next/drain` or call `cancel()`.
- For a cross-call session, call builder `.start()` only in the first call. Later calls should reuse the stored session and call `session.next(...)`, `session.drain()`, `session.show()`, or `session.cancel()`.
- `rg.show(value)` displays an existing value only and does not continue reading a session;strings display as-is, search batches display `text`, file batches display one file per line, and raw results display `stdout`.
- Check stop reasons: search uses `info`, files use `stopReason`;only `done` means fully read, while `maxTextBytes/maxFiles/maxFilesBytes/readTimeout` means incomplete.
- `rg.raw(args, options?)` is not a builder or session;do not call `.next()`, `.drain()`, `.show()`, or `.start()` on it. Await it, then pass the result to `rg.show(...)` if display is needed.
- `rg.show(await rg.raw(...))` prints raw `stdout` only. Inspect the returned result's `stderr` and `exitCode` when diagnosing raw failures.
- Use `raw()` for unstructured flags, version checks, or unsupported chains;`raw()` keeps 16KB by default, pass `{ maxBytes }` for more.
- `FilesBuilder` does not support `.path(...)`. Use `.glob(...)`, `.type(...)`, `.hidden()`, `.noIgnore()`, or `rg.raw(["--files", path])` for path-specific file listing.
- Explicit `.cwd(...)` is needed only when searching outside the bootstrap cwd.
- Check `rg.sessions()` for leftovers. Use `cancel()` or `rg.cancelAll()` when sessions are no longer needed.
