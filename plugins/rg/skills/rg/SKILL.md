---
name: rg
description: "Use when the user mentions rg, ripgrep, or asks to search files through the Node REPL helper."
---

当用户要求在 Node REPL 中使用 `rg` / `ripgrep` 搜索时使用本 skill。

## Bootstrap

每次本 skill 被激活后,先确认 `globalThis.rg` 是否已经注册。未注册时,必须通过 Node REPL `js` tool 执行一次 bootstrap。`rg-client` 位于本插件根目录的 `scripts/rg-client.mjs`,必须用绝对路径导入。默认把 runtime 挂到 `globalThis.rg`。

重复执行 bootstrap 前必须先检查,避免覆盖已有 runtime 和活跃 session:

```js
if (!globalThis.rg) {
  const { setupRgRuntime } = await import("<plugin root>/scripts/rg-client.mjs");
  setupRgRuntime({
    globals: globalThis,
    defaultCwd: nodeRepl.cwd
  });
}
```

如果需要通过 `rgPath` 覆盖 `rg.exe` 路径,只在未注册时执行:

```js
if (!globalThis.rg) {
  const { setupRgRuntime } = await import("<plugin root>/scripts/rg-client.mjs");
  setupRgRuntime({
    globals: globalThis,
    rgPath: "C:/Tools/rg.exe",
    defaultCwd: nodeRepl.cwd
  });
}
```

不要在多个 Node REPL 调用中重复声明同名顶层 `const` / `let`。需要跨调用保留状态时,优先使用 `globalThis` 属性。

## API quick reference

只使用本节列出的方法,不要猜测或发明新的 chain method。

- `rg`: `search(pattern)`, `createSearch(options)`, `files()`, `createFiles(options)`, `raw(args, options?)`, `sessions()`, `cancelAll()`
- `SearchBuilder`: `cwd(path)`, `path(path)`, `glob(pattern)`, `globs(patterns)`, `type(name)`, `typeNot(name)`, `fixedStrings()`, `word()`, `ignoreCase()`, `caseSensitive()`, `smartCase()`, `hidden()`, `noIgnore()`, `follow()`, `multiline()`, `context(n)`, `beforeContext(n)`, `afterContext(n)`, `maxColumns(n)`, `encoding(name)`, `readTimeout(ms)`, `arg(tokenOrTokens)`, `args(tokens)`, `start()`
- `FilesBuilder`: `cwd(path)`, `glob(pattern)`, `globs(patterns)`, `type(name)`, `hidden()`, `noIgnore()`, `follow()`, `readTimeout(ms)`, `arg(tokenOrTokens)`, `args(tokens)`, `start()`
- `SearchSession`: `next(n | { maxResults })`, `cancel()`, `batches(n | { maxResults })`
- `FileSession`: `next(n | { maxFiles })`, `cancel()`, `batches(n | { maxFiles })`

## Cross-call batching

跨多次 Node REPL 调用分批读取时,把 session 存到 `globalThis.rgSession`。创建新 session 前,先取消旧 session:

```js
if (globalThis.rgSession) {
  await globalThis.rgSession.cancel();
}

globalThis.rgSession = rg
  .search("TODO")
  .glob("*.js")
  .start();

const batch = await globalThis.rgSession.next(20);
nodeRepl.write(JSON.stringify({
  count: batch.matches.filter((event) => event.type === "match").length,
  done: batch.done,
  stopReason: batch.stopReason,
  matches: batch.matches
}));
```

下一次 Node REPL 调用继续读取同一个 session:

```js
const batch = await globalThis.rgSession.next(20);
nodeRepl.write(JSON.stringify({
  count: batch.matches.filter((event) => event.type === "match").length,
  done: batch.done,
  stopReason: batch.stopReason,
  matches: batch.matches
}));

if (batch.done) {
  delete globalThis.rgSession;
}
```

如果已经获得足够信息,必须取消并删除 session:

```js
if (globalThis.rgSession) {
  await globalThis.rgSession.cancel();
  delete globalThis.rgSession;
}
```

如果不确定是否有变量被覆盖后遗留的搜索进程,使用 runtime registry 清理:

```js
nodeRepl.write(JSON.stringify(rg.sessions()));
await rg.cancelAll();
```

## One-shot searches

一次性读取少量结果时,使用本地变量并在不需要继续时取消:

```js
const session = rg.search("TODO").glob("*.js").start();
const batch = await session.next(20);
if (!batch.done) {
  await session.cancel();
}
nodeRepl.write(JSON.stringify(batch));
```

Object API 可用 `rg.createSearch({ pattern, globs })`;`async iterator` 可用 `session.batches(50)`,但必须放在 `try/finally` 中取消 session。

列文件或执行 raw:

```js
const files = await rg.files().cwd(nodeRepl.cwd).glob("*.md").start().next(100);
nodeRepl.write(JSON.stringify(files));

const version = await rg.raw(["--version"], { cwd: nodeRepl.cwd });
nodeRepl.write(version.stdout);
```

注意:

- `search` 默认使用 regex,只有调用 `fixedStrings()` 才会加 `-F`。
- bootstrap 已设置 `defaultCwd: nodeRepl.cwd`,普通搜索不需要重复 `.cwd(nodeRepl.cwd)`。只有搜索其它目录时才显式调用 `.cwd(...)`。
- 单次 `next()` 默认最多等待 60s。需要覆盖时使用 `next({ maxResults, timeoutMs })`,不会杀掉 `rg` 或销毁 session;超时后可继续 `next()` 或手动 `cancel()`。
- `search` 内部强制使用 `--json`,不要通过 `arg()` / `args()` 传入会破坏结构化解析的 flags。
- `raw()` 直接执行 `rg` 参数,不限制 flags,适合查看版本或执行非结构化命令。
- 搜索 session 不设置整体 timeout。需要停止时调用 `cancel()`,并删除对应的 `globalThis` 引用。
- `rg.sessions()` 只列出仍活跃的 search/files session;`rg.cancelAll()` 会取消全部活跃 session。
