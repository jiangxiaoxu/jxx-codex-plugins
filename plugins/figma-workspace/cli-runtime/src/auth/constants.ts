import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_FIGMA_WORKSPACE_ENDPOINT = "https://mcp.figma.com/mcp";
export const DEFAULT_CALLBACK_HOST = "127.0.0.1";
export const DEFAULT_CALLBACK_PORT = 18765;
export const DEFAULT_CALLBACK_PATH = "/oauth/callback";
export const DEFAULT_AUTH_TIMEOUT_MS = 180_000;
export const DEFAULT_CLIENT_NAME = "jxx-codex-figma-workspace";
export const DEFAULT_CLIENT_VERSION = "0.5.4";
export const BRIDGE_OAUTH_CACHE_FILENAME = ".figma-workspace-oauth.json";

const distDir = dirname(fileURLToPath(import.meta.url));

export const PLUGIN_ROOT = resolve(distDir, "..");
export const DEFAULT_OAUTH_STATE_PATH = resolve(
  PLUGIN_ROOT,
  ".mcp-oauth-state.json",
);
