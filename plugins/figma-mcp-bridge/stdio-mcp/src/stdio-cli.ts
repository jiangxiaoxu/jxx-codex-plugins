#!/usr/bin/env node
import {
  isDirectRun,
  runFigmaStdioMcpCli,
} from "./cli.js";

if (isDirectRun(import.meta.url)) {
  await runFigmaStdioMcpCli({
    useBridgeOAuthCache: true,
    openBrowser: false,
  });
}
