---
name: rg
description: "Use when the user mentions rg, ripgrep, or asks to search files through the Node REPL helper."
---

在 Node REPL 中通过 `rg-client` 搜索文件时使用本 skill。

## Bootstrap

首次使用先注册 `globalThis.rg`;重复 bootstrap 前必须检查,避免覆盖已有 runtime 或活跃 session:

```js
if (!globalThis.rg) {
  const { setupRgRuntime } = await import("<plugin root>/scripts/rg-client.mjs");
  setupRgRuntime({ globals: globalThis, defaultCwd: nodeRepl.cwd });
}
```

如果需要指定 `rg.exe` 路径,只在未注册时传入 `rgPath`。跨 Node REPL 调用保存状态时使用 `globalThis` 属性,避免重复声明顶层 `const` / `let`。

## API

只使用本节列出的方法,不要猜测或发明新的 chain method。

- `rg`: `search(pattern)`, `createSearch(options)`, `files()`, `createFiles(options)`, `raw(args, options?)`, `sessions()`, `cancelAll()`
- `SearchBuilder`: `cwd(path)`, `path(path)`, `glob(pattern)`, `globs(patterns)`, `type(name)`, `typeNot(name)`, `fixedStrings()`, `word()`, `ignoreCase()`, `caseSensitive()`, `smartCase()`, `hidden()`, `noIgnore()`, `follow()`, `multiline()`, `context(n)`, `beforeContext(n)`, `afterContext(n)`, `maxColumns(n)`, `encoding(name)`, `readTimeout(ms)`, `arg(tokenOrTokens)`, `args(tokens)`, `start()`
- `FilesBuilder`: `cwd(path)`, `glob(pattern)`, `globs(patterns)`, `type(name)`, `hidden()`, `noIgnore()`, `follow()`, `readTimeout(ms)`, `arg(tokenOrTokens)`, `args(tokens)`, `start()`
- `SearchSession`: `next(n | { maxBlocks, timeoutMs })`, `cancel()`, `batches(n | { maxBlocks, timeoutMs })`
- `FileSession`: `next(n | { maxFiles, timeoutMs })`, `cancel()`, `batches(n | { maxFiles, timeoutMs })`

## Search

默认用 `next()` 获取省 token 的 heading-style 文本。`info` 是 stop reason,继续读取还是取消由它决定:

```js
const session = rg.search("TODO").glob("*.js").start();
const batch = await session.next(20);
nodeRepl.write(batch.text);

if (batch.info !== "done") {
  await session.cancel();
}
```

跨调用分批读取:

```js
if (globalThis.rgSession) {
  await globalThis.rgSession.cancel();
  delete globalThis.rgSession;
}

globalThis.rgSession = rg.search("TODO").glob("*.js").start();
const batch = await globalThis.rgSession.next(20);
nodeRepl.write(batch.text);

if (batch.info === "done") {
  delete globalThis.rgSession;
}
```

## Files And Raw

```js
const files = await rg.files().glob("*.md").start().next(100);
nodeRepl.write(JSON.stringify(files));

const version = await rg.raw(["--version"]);
nodeRepl.write(version.stdout);
```

## Usage Notes

- `search` 默认使用 regex;只有调用 `fixedStrings()` 才会加 `-F`。
- bootstrap 已设置 `defaultCwd: nodeRepl.cwd`;只有搜索其它目录时才显式 `.cwd(...)`。
- `search` 内部强制使用 `--json`;不要通过 `arg()` / `args()` 传入会破坏结构化解析的 flags,如 `--json`,`--files`,`-l`,`-L`,`-c`,`-o`。
- `next()` 返回 `{ text, info }`;`text` 最多 12KB,超限时 `info === "maxTextBytes"`。
- `next()` 用 `maxBlocks`;`FileSession.next()` 使用 `maxFiles`。
- 单次读取默认最多等待 60s;传 `timeoutMs` 只影响本次读取,不会杀掉 `rg` 或销毁 session。
- `raw()` 默认最多保留 16KB 输出;需要更多时传 `raw(args, { maxBytes })`。
- `raw()` 不限制 flags,适合查看版本或执行非结构化命令。
- session stderr 内部保留最近 1KB,`stderrPreview` 为最近 10 行;`rg` exit code 大于 1 时会抛 `RgProcessError`。
- 搜索结束或不需要继续时调用 `cancel()` 并删除保存的 session;不确定残留时先看 `rg.sessions()`,再用 `rg.cancelAll()` 清理。
