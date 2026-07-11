#!/usr/bin/env node

import { runFigmaWorkspaceCli } from "../../mcp-server/dist/runtime/workspace-runtime.js";

process.exitCode = await runFigmaWorkspaceCli(["--help"]);
