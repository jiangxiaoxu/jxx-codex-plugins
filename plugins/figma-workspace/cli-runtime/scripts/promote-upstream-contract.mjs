import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  promoteFigmaUpstreamContractCandidate,
} from "../dist/upstream/node-upstream-client.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const acceptedSnapshotPath = resolve(packageRoot, "tests/fixtures/upstream-contract-snapshot.json");
const candidateRoot = resolve(packageRoot, "dev/upstream-contract-candidates");
const help = [
  "Usage: npm run upstream:contract:promote -- --candidate <candidate-id>",
  "",
  "Promotes one candidate after integrity, baseline, disposition, and wrapper coverage gates pass.",
  "This command does not attest that repository tests were run.",
].join("\n");

if (process.argv.includes("--help")) {
  console.log(help);
} else {
  try {
    const candidateId = requireCandidateId(process.argv.slice(2));
    await promoteFigmaUpstreamContractCandidate({
      candidateRoot,
      candidateId,
      acceptedSnapshotPath,
    });
    console.log("Promoted Figma upstream contract candidate " + candidateId + ".");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

function requireCandidateId(args) {
  if (args.length !== 2 || args[0] !== "--candidate" || !args[1]) {
    throw new Error(help);
  }
  return args[1];
}
