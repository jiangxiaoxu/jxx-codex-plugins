import {
  ReadableStream as NodeReadableStream,
  TransformStream as NodeTransformStream,
  WritableStream as NodeWritableStream,
} from "node:stream/web";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type {
  RemoteMcpClientOptions,
} from "./remote-mcp-client.js";
import type {
  FigmaWorkspaceClientOptions,
} from "../mcp/workspace-mcp-server.js";

const BRIDGE_OAUTH_CACHE_FILENAME = ".figma-workspace-oauth.json";
const NODE_WORKSPACE_DEFAULT_CLIENT_MESSAGE = [
  "The ./node-upstream-client createFigmaWorkspaceClient() default client does not connect to the official Figma remote MCP.",
  "Use the bundled figma-workspace CLI for live Figma work, or pass an explicit { client } to createFigmaWorkspaceClient() for a custom upstream.",
].join(" ");

type NodeReplUpstreamClient = NonNullable<FigmaWorkspaceClientOptions["client"]>;

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
  typeof import("./remote-mcp-client.js"),
  typeof import("../mcp/workspace-mcp-server.js"),
] = await Promise.all([
  import("./remote-mcp-client.js"),
  import("../mcp/workspace-mcp-server.js"),
]);

export const RemoteMcpClient = clientModule.RemoteMcpClient;
export const isRemoteMcpOAuthError = clientModule.isRemoteMcpOAuthError;
export function createRemoteMcpClient(
  options: RemoteMcpClientOptions = {},
): ReturnType<typeof clientModule.createRemoteMcpClient> {
  return clientModule.createRemoteMcpClient(withNodeReplRemoteDefaults(options));
}

export function createFigmaWorkspaceClient(
  options: FigmaWorkspaceClientOptions = {},
): ReturnType<typeof replServerModule.createFigmaWorkspaceClient> {
  return replServerModule.createFigmaWorkspaceClient(withNodeReplReplDefaults(options));
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

function withNodeReplReplDefaults(options: FigmaWorkspaceClientOptions): FigmaWorkspaceClientOptions {
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
    throw new Error(NODE_WORKSPACE_DEFAULT_CLIENT_MESSAGE);
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
  };
}
export {
  FIGMA_UPSTREAM_CONTRACT_SNAPSHOT_SCHEMA_VERSION,
  createFigmaUpstreamContractSnapshot,
  diffFigmaUpstreamContractSnapshots,
  formatFigmaUpstreamContractElapsedTime,
  formatFigmaUpstreamContractDrift,
  normalizeFigmaUpstreamContractSnapshot,
  readFigmaUpstreamContractSnapshotFile,
  writeFigmaUpstreamContractSnapshotFile,
  type FigmaUpstreamContractClient,
  type FigmaUpstreamContractDrift,
  type FigmaUpstreamContractSnapshot,
} from "./upstream-contract-snapshot.js";
export type { RemoteMcpClientOptions } from "./remote-mcp-client.js";
export type {
  FigmaWorkspaceClient,
  FigmaWorkspaceClientOptions,
} from "../mcp/workspace-mcp-server.js";
