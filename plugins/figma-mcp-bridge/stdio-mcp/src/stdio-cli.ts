#!/usr/bin/env node
import {
  isDirectRun,
  startFigmaStdioMcpServer,
} from "./index.js";

if (isDirectRun(import.meta.url)) {
  await startFigmaStdioMcpServer({
    useBridgeOAuthCache: true,
    openBrowser: false,
  });
}
