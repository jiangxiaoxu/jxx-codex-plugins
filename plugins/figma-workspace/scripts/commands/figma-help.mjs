#!/usr/bin/env node

import { runFigmaCommandCli } from "../../mcp-server/dist/cli/figma-command-runtime.js";

process.exitCode = await runFigmaCommandCli(["--help"]);
