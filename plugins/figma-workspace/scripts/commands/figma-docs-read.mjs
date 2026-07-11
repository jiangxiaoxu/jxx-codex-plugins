#!/usr/bin/env node

import { runFigmaCommand } from "../../mcp-server/dist/cli/figma-command-runtime.js";

process.exitCode = await runFigmaCommand("docs:read", process.argv.slice(2));
