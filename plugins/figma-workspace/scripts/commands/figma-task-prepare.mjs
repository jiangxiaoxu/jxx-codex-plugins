#!/usr/bin/env node

import { runFigmaCommand } from "../../cli-runtime/dist/cli/figma-command-runtime.js";

process.exitCode = await runFigmaCommand("task:prepare", process.argv.slice(2));
