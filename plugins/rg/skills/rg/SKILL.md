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

`rg.search(pattern)` builds a text search. `rg.files()` builds a file listing. `rg.raw(args, options?)` runs low-level ripgrep arguments. `rg.show(value)` prints an existing result.

Builders collect filters before a command starts. Use `next(n)` for one batch, `drain()` for remaining output with the built-in cap, `show()` to drain and print, and `start()` when the session must continue across calls.

Sessions represent running rg processes. Use `next(n)` to read more, `drain()` to read the remaining capped output, `show()` to display the remaining capped output, and `cancel()` when the session is no longer needed.

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
```

Batch control:

```js
const session = rg.search("TODO").glob("*.js").start();
await rg.show(await session.next(20));
await session.show();
```

Cross-call session:

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

Raw and cleanup:

```js
await rg.show(await rg.raw(["--version"]));
await rg.show(await rg.raw(["TODO", "src"], { maxBytes: 32 * 1024 }));
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
- `rg.show(value)` displays an existing value only and does not continue reading a session;search batches display `text`, file batches display one file per line, and raw results display `stdout`.
- Check stop reasons: search uses `info`, files use `stopReason`;only `done` means fully read, while `maxTextBytes/maxFiles/maxFilesBytes/readTimeout` means incomplete.
- Use `raw()` for unstructured flags or version checks;`raw()` keeps 16KB by default, pass `{ maxBytes }` for more.
- Explicit `.cwd(...)` is needed only when searching outside the bootstrap cwd.
- Check `rg.sessions()` for leftovers. Use `cancel()` or `rg.cancelAll()` when sessions are no longer needed.
