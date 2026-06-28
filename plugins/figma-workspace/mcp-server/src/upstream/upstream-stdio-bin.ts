#!/usr/bin/env node
import {
  isDirectRun,
  runFigmaWorkspaceUpstreamStdioCli,
} from "./upstream-stdio-cli.js";

if (isDirectRun(import.meta.url)) {
  await runFigmaWorkspaceUpstreamStdioCli({
    useBridgeOAuthCache: true,
    openBrowser: false,
  });
}
