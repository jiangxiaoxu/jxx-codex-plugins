import { runTaskMemoryCommand } from "../../src/task-memory-cli.mjs";

process.exitCode = runTaskMemoryCommand("init", process.argv.slice(2));
