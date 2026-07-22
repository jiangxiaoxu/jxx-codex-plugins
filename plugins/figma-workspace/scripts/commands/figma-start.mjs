#!/usr/bin/env node

import { runFigmaCommandCli } from "../../cli-runtime/dist/cli/figma-command-runtime.js";

process.exitCode = await runFigmaCommandCli(["--help"]);
