#!/usr/bin/env node

import { runFigmaWorkspaceCli } from "../../cli-runtime/dist/runtime/workspace-runtime.js";

process.exitCode = await runFigmaWorkspaceCli(["--help"]);
