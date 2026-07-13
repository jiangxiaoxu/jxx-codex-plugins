import { runTaskMemoryCommand } from "../../src/task-memory-cli.mjs";

process.exitCode = runTaskMemoryCommand("status", process.argv.slice(2));
