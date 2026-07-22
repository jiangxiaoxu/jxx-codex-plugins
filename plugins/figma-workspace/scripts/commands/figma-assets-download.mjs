#!/usr/bin/env node

import { runFigmaCommand } from "../../cli-runtime/dist/cli/figma-command-runtime.js";

process.exitCode = await runFigmaCommand("assets:download", process.argv.slice(2));
