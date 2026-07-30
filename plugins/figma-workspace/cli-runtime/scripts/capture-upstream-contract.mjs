import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  captureFigmaUpstreamContractCandidate,
  createDefaultFigmaUpstreamContractCandidateId,
  createFigmaUpstreamContractSnapshot,
  createRemoteMcpClient,
  isRemoteMcpOAuthError,
} from "../dist/upstream/node-upstream-client.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const acceptedSnapshotPath = resolve(packageRoot, "tests/fixtures/upstream-contract-snapshot.json");
const candidateRoot = resolve(packageRoot, "dev/upstream-contract-candidates");
const help = [
  "Usage: npm run upstream:contract:capture -- [--candidate <candidate-id>]",
  "",
  "Captures the live official Figma MCP contract into an ignored candidate directory.",
  "The accepted snapshot is never modified.",
].join("\n");

if (process.argv.includes("--help")) {
  console.log(help);
} else {
  const candidateId = readCandidateId(process.argv.slice(2))
    ?? createDefaultFigmaUpstreamContractCandidateId();
  const client = createRemoteMcpClient({ openBrowser: false });
  try {
    const snapshot = await createFigmaUpstreamContractSnapshot(client);
    const manifest = await captureFigmaUpstreamContractCandidate({
      candidateRoot,
      candidateId,
      acceptedSnapshotPath,
      snapshot,
    });
    console.log("Captured Figma upstream contract candidate " + manifest.candidateId + ".");
    console.log("Candidate directory: " + resolve(candidateRoot, manifest.candidateId));
    console.log("Run npm run upstream:contract:report -- --candidate " + manifest.candidateId + ".");
  } catch (error) {
    if (isRemoteMcpOAuthError(error)) {
      console.error("Unable to capture official Figma MCP upstream contract: " + error.code
        + ". Run npm run login:figma-http, then retry.");
    } else {
      console.error("Unable to capture official Figma MCP upstream contract.");
      console.error(error);
    }
    process.exitCode = 1;
  } finally {
    await client.close().catch(() => undefined);
  }
}

function readCandidateId(args) {
  if (args.length === 0) return undefined;
  if (args.length !== 2 || args[0] !== "--candidate" || !args[1]) {
    throw new Error(help);
  }
  return args[1];
}
