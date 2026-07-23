#!/usr/bin/env node
// @ts-check

import { runFigmaCommandEntrypoint } from "./command-entrypoint.mjs";

await runFigmaCommandEntrypoint({
  commandName: "figma:docs:search",
  fixedArgs: ["docs:search"],
});
