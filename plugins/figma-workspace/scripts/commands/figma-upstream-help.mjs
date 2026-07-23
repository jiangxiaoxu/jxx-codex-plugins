#!/usr/bin/env node
// @ts-check

import { runFigmaCommandEntrypoint } from "./command-entrypoint.mjs";

await runFigmaCommandEntrypoint({
  commandName: "figma:upstream:help",
  fixedArgs: ["upstream"],
  familyHelp: true,
});
