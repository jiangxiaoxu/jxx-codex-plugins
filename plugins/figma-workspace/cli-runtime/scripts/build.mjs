import { createHash } from "node:crypto";
import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import * as ts from "@typescript/typescript6";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");

const sharedBuildOptions = {
  platform: "node",
  format: "esm",
  target: "node20",
};
const bundledEsmRequireBanner =
  [
    'import { createRequire as __figmaWorkspaceCreateRequire } from "node:module";',
    'import { fileURLToPath as __figmaWorkspaceFileURLToPath } from "node:url";',
    'import { dirname as __figmaWorkspacePathDirname } from "node:path";',
    "const require = __figmaWorkspaceCreateRequire(import.meta.url);",
    "const __filename = __figmaWorkspaceFileURLToPath(import.meta.url);",
    "const __dirname = __figmaWorkspacePathDirname(__filename);",
  ].join("\n");

const sharedRuntimeOutput = {
  entryPoint: resolve(root, "src/runtime/workspace-runtime.ts"),
  outfile: resolve(dist, "runtime/workspace-runtime.js"),
};
const typescriptCompilerRuntimeOutput = {
  entryPoint: resolve(root, "src/runtime/typescript-compiler-runtime.ts"),
  outfile: resolve(dist, "runtime/typescript-compiler-runtime.js"),
};
const commandRuntimeOutput = {
  entryPoint: resolve(root, "src/cli/figma-command-runtime.ts"),
  outfile: resolve(dist, "cli/figma-command-runtime.js"),
};
const credentialStoreOutput = {
  entryPoint: resolve(root, "src/auth/credential-store.ts"),
  outfile: resolve(dist, "auth/credential-store.js"),
};
const publicWrappers = [
  {
    outfile: resolve(dist, "upstream/node-upstream-client.js"),
    source: [
      "export {",
      "  FIGMA_UPSTREAM_CONTRACT_SNAPSHOT_SCHEMA_VERSION,",
      "  NodeUpstreamRemoteMcpClient as RemoteMcpClient,",
      "  createFigmaUpstreamContractSnapshot,",
      "  createNodeUpstreamFigmaWorkspaceClient as createFigmaWorkspaceClient,",
      "  createNodeUpstreamRemoteMcpClient as createRemoteMcpClient,",
      "  diffFigmaUpstreamContractSnapshots,",
      "  formatFigmaUpstreamContractDrift,",
      "  formatFigmaUpstreamContractElapsedTime,",
      "  installNodeReplWebStreamGlobals,",
      "  isNodeUpstreamRemoteMcpOAuthError as isRemoteMcpOAuthError,",
      "  normalizeFigmaUpstreamContractSnapshot,",
      "  readFigmaUpstreamContractSnapshotFile,",
      "  writeFigmaUpstreamContractSnapshotFile,",
      '} from "../runtime/workspace-runtime.js";',
    ].join("\n"),
  },
  {
    outfile: resolve(dist, "cli/figma-workspace-cli.js"),
    executable: true,
    source: [
      "#!/usr/bin/env node",
      'import { runFigmaWorkspaceCli } from "../runtime/workspace-runtime.js";',
      "",
      "process.exitCode = await runFigmaWorkspaceCli(process.argv.slice(2));",
    ].join("\n"),
  },
];

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildDistribution();
}

async function buildDistribution() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });

  await build({
    ...sharedBuildOptions,
    bundle: true,
    banner: { js: bundledEsmRequireBanner },
    entryPoints: [typescriptCompilerRuntimeOutput.entryPoint],
    outfile: typescriptCompilerRuntimeOutput.outfile,
  });
  await rewriteBuiltFile(typescriptCompilerRuntimeOutput.outfile);

  await build({
    ...sharedBuildOptions,
    bundle: true,
    banner: { js: bundledEsmRequireBanner },
    entryPoints: [sharedRuntimeOutput.entryPoint],
    external: ["./typescript-compiler-runtime.js"],
    outfile: sharedRuntimeOutput.outfile,
  });
  await rewriteBuiltFile(sharedRuntimeOutput.outfile);

  await build({
    ...sharedBuildOptions,
    bundle: true,
    banner: { js: bundledEsmRequireBanner },
    entryPoints: [commandRuntimeOutput.entryPoint],
    external: ["../runtime/workspace-runtime.js"],
    outfile: commandRuntimeOutput.outfile,
  });
  await rewriteBuiltFile(commandRuntimeOutput.outfile);

  await build({
    ...sharedBuildOptions,
    bundle: true,
    banner: { js: bundledEsmRequireBanner },
    entryPoints: [credentialStoreOutput.entryPoint],
    outfile: credentialStoreOutput.outfile,
  });
  await rewriteBuiltFile(credentialStoreOutput.outfile);

  for (const output of publicWrappers) {
    await writeWrapper(output.outfile, output.source, output.executable === true);
  }

  await stageCanonicalCorpus();
  await stageProjectDocs();
  await stageHelperDeclarations();
}

function stripTrailingWhitespace(value) {
  return value.replace(/[ \t]+$/gm, "");
}

async function rewriteBuiltFile(file) {
  const source = await readFile(file, "utf8");
  await writeFile(file, stripTrailingWhitespace(source), "utf8");
}

async function writeWrapper(file, source, executable) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${stripTrailingWhitespace(source)}\n`, "utf8");
  if (executable) {
    await chmod(file, 0o755);
  }
}

async function stageCanonicalCorpus() {
  const source = resolve(root, "../skills/figma-workspace/references/canonical-corpus");
  const target = resolve(dist, "skills/figma-workspace/references/canonical-corpus");
  const manifestFile = resolve(source, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  if (manifest.schemaVersion !== 2) {
    throw new Error("Canonical corpus manifest schemaVersion must be 2 before staging.");
  }
  const runtimeFiles = ["manifest.json", manifest.routeCatalog?.file, manifest.corpus?.file];
  for (const file of runtimeFiles) {
    if (typeof file !== "string" || !/^[a-z0-9][a-z0-9.-]*$/u.test(file) || file.includes("..")) {
      throw new Error(`Canonical corpus manifest contains an unsafe runtime file: ${String(file)}.`);
    }
  }
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await Promise.all(runtimeFiles.map((file) => cp(resolve(source, file), resolve(target, file))));
}

async function stageProjectDocs() {
  const source = resolve(root, "../skills/figma-workspace/references");
  const target = resolve(dist, "skills/figma-workspace/references");
  const files = [
    "figma-workspace-overview.md",
    "figma-workspace-workflow.md",
    "figma-workspace-guidance-and-lookup.md",
    "figma-workspace-safety.md",
    "figma-workspace-diagnostics.md",
    "figma-workspace-artifacts.md",
    "figma-workspace-upstream-tools.md",
  ];
  await mkdir(target, { recursive: true });
  await Promise.all(files.map((file) => cp(resolve(source, file), resolve(target, file))));
}

async function stageHelperDeclarations() {
  const source = resolve(root, "src/runtime/figma-workspace-helpers.d.ts");
  const figmaTypings = resolve(root, "node_modules/@figma/plugin-typings");
  const typescriptLib = resolve(root, "node_modules/@typescript/typescript6/node_modules/typescript/lib");
  await cp(source, resolve(dist, "runtime/figma-workspace-helpers.d.ts"));
  const stagedFigmaTypings = resolve(dist, "runtime/figma-plugin-typings");
  await stageFigmaPluginTypings(figmaTypings, stagedFigmaTypings);
  await stageFigmaPluginApiIndex(figmaTypings, resolve(dist, "runtime/figma-plugin-api-index"));
  await stageTypescriptLib(typescriptLib, resolve(dist, "runtime/typescript-lib"));
}

async function stageFigmaPluginTypings(sourceDir, targetDir) {
  await mkdir(targetDir, { recursive: true });
  await Promise.all(["index.d.ts", "plugin-api.d.ts"]
    .map((entry) => cp(resolve(sourceDir, entry), resolve(targetDir, entry))));
}

export async function stageFigmaPluginApiIndex(sourceDir, targetDir) {
  const sourceFiles = ["index.d.ts", "plugin-api.d.ts"];
  const packageData = JSON.parse(await readFile(resolve(sourceDir, "package.json"), "utf8"));
  const sourceEntries = [];
  const sourceInputs = [];
  for (const sourceFile of sourceFiles) {
    const sourceText = normalizeLineEndings(await readFile(resolve(sourceDir, sourceFile), "utf8"));
    sourceEntries.push({ file: sourceFile, sha256: sha256(sourceText) });
    sourceInputs.push({ sourceFile, sourceText });
  }
  const records = createPluginApiSymbolRecords(sourceInputs);
  const indexText = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  const indexSha256 = sha256(indexText);
  const indexFile = `index-${indexSha256}.jsonl`;
  const manifest = {
    schemaVersion: 2,
    source: {
      package: "@figma/plugin-typings",
      version: packageData.version,
      files: sourceEntries,
    },
    index: { file: indexFile, recordCount: records.length, sha256: indexSha256 },
    integrity: {
      algorithm: "sha256",
      contentHashes: Object.fromEntries(records.map((record) => [record.id, record.contentSha256])),
    },
  };
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });
  await writeFile(resolve(targetDir, indexFile), indexText, "utf8");
  await writeFile(resolve(targetDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export function createPluginApiSymbolRecords(sourceInputs) {
  const declarations = sourceInputs.flatMap(({ sourceFile, sourceText }) =>
    collectPluginApiDeclarations(sourceFile, sourceText));
  const runtimeAliases = createRuntimeQualifiedAliases(declarations);
  return declarations.map((declaration) => {
    const qualifiedAliases = new Set();
    if (declaration.ownerSymbol) {
      qualifiedAliases.add(`${declaration.ownerSymbol}.${declaration.symbol}`);
    }
    for (const alias of runtimeAliases.get(declaration) ?? []) {
      qualifiedAliases.add(alias);
    }
    const text = declaration.lines.slice(declaration.lineStart - 1, declaration.lineEnd).join("\n");
    return {
      schemaVersion: 2,
      id: `@figma/plugin-typings/${declaration.sourceFile}:${declaration.declarationLine}:${declaration.symbol}`,
      symbol: declaration.symbol,
      ownerSymbol: declaration.ownerSymbol,
      declarationKind: declaration.declarationKind,
      qualifiedAliases: [...qualifiedAliases].sort(),
      sourceFile: declaration.sourceFile,
      declarationLine: declaration.declarationLine,
      lineStart: declaration.lineStart,
      lineEnd: declaration.lineEnd,
      contentSha256: sha256(text),
      text,
    };
  });
}

function collectPluginApiDeclarations(sourceFile, sourceText) {
  const source = ts.createSourceFile(
    sourceFile,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const lines = sourceText.split("\n");
  const declarations = [];

  const append = (nameNode, declarationKind, ownerSymbol = null, typeNode = undefined) => {
    if (!nameNode || !ts.isIdentifier(nameNode)) return;
    const symbolIndex = source.getLineAndCharacterOfPosition(nameNode.getStart(source)).line;
    const start = pluginApiChunkStart(lines, symbolIndex);
    const end = pluginApiChunkEnd(lines, symbolIndex);
    declarations.push({
      sourceFile,
      lines,
      symbol: nameNode.text,
      ownerSymbol,
      declarationKind,
      declarationLine: symbolIndex + 1,
      lineStart: start + 1,
      lineEnd: end,
      referencedType: directNamedTypeReference(typeNode),
    });
  };

  const visitMembers = (ownerSymbol, members) => {
    for (const member of members) {
      if (ts.isMethodSignature(member) || ts.isMethodDeclaration(member)) {
        append(member.name, "method", ownerSymbol);
      } else if (ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)) {
        append(member.name, "property", ownerSymbol, member.type);
      } else if (ts.isGetAccessorDeclaration(member)) {
        append(member.name, "getter", ownerSymbol, member.type);
      } else if (ts.isSetAccessorDeclaration(member)) {
        append(member.name, "setter", ownerSymbol);
      }
    }
  };

  const visitStatements = (statements, namespaceOwner = null) => {
    for (const statement of statements) {
      if (ts.isInterfaceDeclaration(statement)) {
        append(statement.name, "interface", namespaceOwner);
        visitMembers(statement.name.text, statement.members);
      } else if (ts.isTypeAliasDeclaration(statement)) {
        append(statement.name, "type-alias", namespaceOwner, statement.type);
      } else if (ts.isClassDeclaration(statement)) {
        append(statement.name, "class", namespaceOwner);
        if (statement.name) visitMembers(statement.name.text, statement.members);
      } else if (ts.isEnumDeclaration(statement)) {
        append(statement.name, "enum", namespaceOwner);
        for (const member of statement.members) {
          append(member.name, "enum-member", statement.name.text);
        }
      } else if (ts.isFunctionDeclaration(statement)) {
        append(statement.name, "function", namespaceOwner);
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          append(declaration.name, "variable", namespaceOwner, declaration.type);
        }
      } else if (ts.isModuleDeclaration(statement)) {
        const isGlobalAugmentation = (statement.flags & ts.NodeFlags.GlobalAugmentation) !== 0;
        if (ts.isIdentifier(statement.name) && !isGlobalAugmentation) {
          append(statement.name, "namespace", namespaceOwner);
        }
        let body = statement.body;
        while (body && ts.isModuleDeclaration(body)) body = body.body;
        if (body && ts.isModuleBlock(body)) {
          visitStatements(
            body.statements,
            ts.isIdentifier(statement.name) && !isGlobalAugmentation ? statement.name.text : namespaceOwner,
          );
        }
      }
    }
  };

  visitStatements(source.statements);
  return declarations;
}

function directNamedTypeReference(typeNode) {
  if (!typeNode) return undefined;
  if (ts.isParenthesizedTypeNode(typeNode)) return directNamedTypeReference(typeNode.type);
  if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
    return typeNode.typeName.text;
  }
  if (ts.isUnionTypeNode(typeNode)) {
    const references = new Set(typeNode.types
      .map((entry) => directNamedTypeReference(entry))
      .filter((entry) => entry !== undefined));
    return references.size === 1 ? [...references][0] : undefined;
  }
  return undefined;
}

function createRuntimeQualifiedAliases(declarations) {
  const aliases = new Map();
  const membersByOwner = new Map();
  for (const declaration of declarations) {
    if (!declaration.ownerSymbol) continue;
    const members = membersByOwner.get(declaration.ownerSymbol) ?? [];
    members.push(declaration);
    membersByOwner.set(declaration.ownerSymbol, members);
  }

  const roots = declarations.filter((declaration) =>
    declaration.declarationKind === "variable"
      && declaration.symbol === "figma"
      && declaration.referencedType === "PluginAPI");
  const pending = roots.map((root) => ({ typeName: root.referencedType, path: root.symbol, depth: 0 }));
  const visited = new Set();
  while (pending.length > 0) {
    const current = pending.shift();
    const visitKey = `${current.typeName}:${current.path}`;
    if (visited.has(visitKey) || current.depth > 4) continue;
    visited.add(visitKey);
    for (const member of membersByOwner.get(current.typeName) ?? []) {
      const alias = `${current.path}.${member.symbol}`;
      const memberAliases = aliases.get(member) ?? [];
      memberAliases.push(alias);
      aliases.set(member, memberAliases);
      if (member.declarationKind === "property" && member.referencedType) {
        pending.push({ typeName: member.referencedType, path: alias, depth: current.depth + 1 });
      }
    }
  }
  return aliases;
}

function pluginApiSymbol(line) {
  const normalized = line.trim();
  const declaration = /^(?:export\s+)?(?:declare\s+)?(?:interface|type|class|enum|namespace|function|const|let|var)\s+([$A-Z_a-z][$\w]*)/u.exec(normalized);
  if (declaration) return declaration[1];
  const member = /^(?:readonly\s+)?([$A-Z_a-z][$\w]*)\??\s*(?:<[^>]*>)?\s*(?:\(|:)/u.exec(normalized);
  return member?.[1];
}

function pluginApiChunkStart(lines, symbolIndex) {
  let start = symbolIndex;
  for (let index = symbolIndex - 1; index >= Math.max(0, symbolIndex - 18); index -= 1) {
    const line = lines[index].trim();
    if (line === "" || line.startsWith("/**") || line.startsWith("*") || line.startsWith("*/")) {
      start = index;
      continue;
    }
    break;
  }
  return start;
}

function pluginApiChunkEnd(lines, symbolIndex) {
  let end = symbolIndex + 1;
  for (let index = symbolIndex + 1; index < Math.min(lines.length, symbolIndex + 12); index += 1) {
    if (index > symbolIndex + 1 && pluginApiSymbol(lines[index])) break;
    end = index + 1;
    if (lines[index].trim() === "") break;
  }
  return end;
}

function normalizeLineEndings(value) {
  return value.replace(/\r\n/gu, "\n");
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function stageTypescriptLib(sourceDir, targetDir) {
  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(sourceDir);
  await Promise.all(entries
    .filter((entry) => /^lib\..*\.d\.ts$/u.test(entry))
    .map((entry) => cp(resolve(sourceDir, entry), resolve(targetDir, entry))));
}
