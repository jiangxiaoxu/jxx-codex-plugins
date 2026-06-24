import {
  ReadableStream as NodeReadableStream,
  TransformStream as NodeTransformStream,
  WritableStream as NodeWritableStream,
} from "node:stream/web";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type {
  RemoteMcpClientOptions,
} from "./client.js";
import type {
  FigmaReplClientOptions,
} from "./repl-server.js";

const BRIDGE_OAUTH_CACHE_FILENAME = ".figma-mcp-bridge-oauth.json";
const NODE_REPL_DEFAULT_CLIENT_MESSAGE = [
  "The ./node-repl createFigmaReplClient() default client does not connect to the official Figma remote MCP.",
  "Use the hosted figma_repl_mcp stdio MCP server for live Figma work, or pass an explicit { client } to createFigmaReplClient() for a custom upstream.",
].join(" ");

type NodeReplUpstreamClient = NonNullable<FigmaReplClientOptions["client"]>;

export function installNodeReplWebStreamGlobals(): void {
  installGlobal("ReadableStream", NodeReadableStream);
  installGlobal("TransformStream", NodeTransformStream);
  installGlobal("WritableStream", NodeWritableStream);
}

function installGlobal(name: string, value: object): void {
  if (Reflect.get(globalThis, name) === undefined) {
    Reflect.set(globalThis, name, value);
  }
}

installNodeReplWebStreamGlobals();

const [
  clientModule,
  replServerModule,
]: [
  typeof import("./client.js"),
  typeof import("./repl-server.js"),
] = await Promise.all([
  import("./client.js"),
  import("./repl-server.js"),
]);

export const RemoteMcpClient = clientModule.RemoteMcpClient;
export function createRemoteMcpClient(
  options: RemoteMcpClientOptions = {},
): ReturnType<typeof clientModule.createRemoteMcpClient> {
  return clientModule.createRemoteMcpClient(withNodeReplRemoteDefaults(options));
}

export function createFigmaReplClient(
  options: FigmaReplClientOptions = {},
): ReturnType<typeof replServerModule.createFigmaReplClient> {
  return replServerModule.createFigmaReplClient(withNodeReplReplDefaults(options));
}

function withNodeReplRemoteDefaults(options: RemoteMcpClientOptions): RemoteMcpClientOptions {
  if (options.statePath || options.useBridgeOAuthCache === false) {
    return options;
  }
  return {
    ...options,
    statePath: defaultBridgeOAuthCachePath(),
    useBridgeOAuthCache: false,
  };
}

function withNodeReplReplDefaults(options: FigmaReplClientOptions): FigmaReplClientOptions {
  if (options.client) {
    return options;
  }
  return {
    ...options,
    client: createNodeReplDefaultUpstreamClient(),
  };
}

function defaultBridgeOAuthCachePath(): string {
  return resolve(homedir(), ".codex", BRIDGE_OAUTH_CACHE_FILENAME);
}

function createNodeReplDefaultUpstreamClient(): NodeReplUpstreamClient {
  const rejectUpstreamUse = () => {
    throw new Error(NODE_REPL_DEFAULT_CLIENT_MESSAGE);
  };
  return {
    async connect() {
      rejectUpstreamUse();
    },
    async close() {
      return undefined;
    },
    async listTools() {
      rejectUpstreamUse();
    },
    async callTool() {
      rejectUpstreamUse();
    },
    async listResources() {
      rejectUpstreamUse();
    },
    async readResource() {
      rejectUpstreamUse();
    },
  };
}
export type { RemoteMcpClientOptions } from "./client.js";
export type {
  FigmaReplClient,
  FigmaReplClientOptions,
} from "./repl-server.js";
