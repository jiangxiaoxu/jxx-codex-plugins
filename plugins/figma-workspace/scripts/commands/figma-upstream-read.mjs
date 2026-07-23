#!/usr/bin/env node
// @ts-check

import { runFigmaCommandEntrypoint } from "./command-entrypoint.mjs";

await runFigmaCommandEntrypoint({
  commandName: "figma:upstream:read",
  fixedArgs: ["upstream:read"],
});
