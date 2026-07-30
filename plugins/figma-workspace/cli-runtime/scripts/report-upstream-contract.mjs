import { dirname, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  formatFigmaUpstreamContractSemanticReport,
  reportFigmaUpstreamContractCandidate,
} from "../dist/upstream/node-upstream-client.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const acceptedSnapshotPath = resolve(packageRoot, "tests/fixtures/upstream-contract-snapshot.json");
const candidateRoot = resolve(packageRoot, "dev/upstream-contract-candidates");
const help = [
  "Usage: npm run upstream:contract:report -- --candidate <candidate-id> [--disposition-file <path>]",
  "",
  "Generates deterministic JSON and Markdown semantic drift reports for one candidate.",
].join("\n");

if (process.argv.includes("--help")) {
  console.log(help);
} else {
  try {
    const parsed = parseArguments(process.argv.slice(2));
    const dispositions = parsed.dispositionFile
      ? JSON.parse(await readFile(resolve(parsed.dispositionFile), "utf8"))
      : undefined;
    const report = await reportFigmaUpstreamContractCandidate({
      candidateRoot,
      candidateId: parsed.candidateId,
      acceptedSnapshotPath,
      dispositions,
    });
    console.log(formatFigmaUpstreamContractSemanticReport(report));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

function parseArguments(args) {
  let candidateId;
  let dispositionFile;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(help);
    if (flag === "--candidate" && !candidateId) candidateId = value;
    else if (flag === "--disposition-file" && !dispositionFile) dispositionFile = value;
    else throw new Error(help);
  }
  if (!candidateId) throw new Error(help);
  return { candidateId, dispositionFile };
}
