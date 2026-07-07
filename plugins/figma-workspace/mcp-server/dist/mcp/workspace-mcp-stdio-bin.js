#!/usr/bin/env node
import {
  isFigmaWorkspaceMcpDirectRun as isDirectRun,
  runFigmaWorkspaceMcpCli,
} from "../runtime/workspace-runtime.js";

if (isDirectRun(import.meta.url)) {
  await runFigmaWorkspaceMcpCli({
    useBridgeOAuthCache: true,
    openBrowser: false,
  });
}
