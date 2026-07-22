#!/usr/bin/env node

import { runFigmaWorkspaceCli } from "../../cli-runtime/dist/runtime/workspace-runtime.js";

process.exitCode = await runFigmaWorkspaceCli(process.argv.slice(2));
