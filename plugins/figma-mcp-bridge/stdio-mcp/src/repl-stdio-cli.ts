#!/usr/bin/env node
import {
  isDirectRun,
  runFigmaReplMcpCli,
} from "./repl-cli.js";

if (isDirectRun(import.meta.url)) {
  await runFigmaReplMcpCli({
    useBridgeOAuthCache: true,
    openBrowser: false,
  });
}
