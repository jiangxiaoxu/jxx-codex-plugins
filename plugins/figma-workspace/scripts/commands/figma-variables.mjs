#!/usr/bin/env node

import { runFigmaCommand } from "../../cli-runtime/dist/cli/figma-command-runtime.js";

process.exitCode = await runFigmaCommand("variables", process.argv.slice(2));
