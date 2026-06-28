#!/usr/bin/env node
import {
  isDirectRun,
  runFigmaWorkspaceMcpCli
} from "./workspace-mcp-cli.js";
if (isDirectRun(import.meta.url)) {
  await runFigmaWorkspaceMcpCli({
    useBridgeOAuthCache: true,
    openBrowser: false
  });
}
