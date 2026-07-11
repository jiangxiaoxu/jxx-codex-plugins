#!/usr/bin/env node
import { runFigmaWorkspaceCli } from "../runtime/workspace-runtime.js";

process.exitCode = await runFigmaWorkspaceCli(process.argv.slice(2));
