#!/usr/bin/env node
import {
  isFigmaWorkspaceUpstreamDirectRun as isDirectRun,
  runFigmaWorkspaceUpstreamStdioCli,
} from "../runtime/workspace-runtime.js";

if (isDirectRun(import.meta.url)) {
  await runFigmaWorkspaceUpstreamStdioCli({
    useBridgeOAuthCache: true,
    openBrowser: false,
  });
}
