#!/usr/bin/env node
// @ts-check

import { runFigmaCommandEntrypoint } from "./command-entrypoint.mjs";

await runFigmaCommandEntrypoint({
  commandName: "figma:code-connect:help",
  fixedArgs: ["code-connect"],
  familyHelp: true,
});
