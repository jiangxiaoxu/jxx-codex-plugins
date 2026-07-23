#!/usr/bin/env node
// @ts-check

import { runFigmaCommandEntrypoint } from "./command-entrypoint.mjs";

await runFigmaCommandEntrypoint({
  commandName: "figma:assets:apply",
  fixedArgs: ["assets:apply"],
});
