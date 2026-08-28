#!/usr/bin/env node
// @ts-check

import { runFigmaCommandEntrypoint } from "./command-entrypoint.mjs";

await runFigmaCommandEntrypoint({
  commandName: "figma:code-connect:plan",
  fixedArgs: ["code-connect:plan"],
});
