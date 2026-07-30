import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  checkFigmaUpstreamContractCandidate,
  createFigmaUpstreamContractSemanticReport,
  createFigmaUpstreamContractSnapshot,
  createRemoteMcpClient,
  formatFigmaUpstreamContractElapsedTime,
  formatFigmaUpstreamContractSemanticReport,
  isRemoteMcpOAuthError,
  readFigmaUpstreamContractSnapshotFile,
  serializeFigmaUpstreamContractSnapshot,
} from "../dist/upstream/node-upstream-client.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const acceptedSnapshotPath = resolve(packageRoot, "tests/fixtures/upstream-contract-snapshot.json");
const candidateRoot = resolve(packageRoot, "dev/upstream-contract-candidates");
const help = [
  "Usage:",
  "  npm run upstream:contract:check",
  "  npm run upstream:contract:check -- --candidate <candidate-id>",
  "",
  "Without --candidate, compares the accepted snapshot with the live official Figma MCP contract.",
  "With --candidate, verifies integrity, report freshness, baseline identity, dispositions, and wrapper coverage.",
  "It does not attest that repository tests were run.",
].join("\n");

if (process.argv.includes("--help")) {
  console.log(help);
} else {
  const startedAt = performance.now();
  const args = process.argv.slice(2);
  try {
    const candidateId = readCandidateId(args);
    if (candidateId) {
      const report = await checkFigmaUpstreamContractCandidate({
        candidateRoot,
        candidateId,
        acceptedSnapshotPath,
      });
      console.log("Figma upstream contract candidate " + candidateId + " passes all promotion gates.");
      console.log(formatFigmaUpstreamContractSemanticReport(report));
    } else {
      await checkLiveContract();
    }
  } catch (error) {
    if (isRemoteMcpOAuthError(error)) {
      console.error("Unable to compare official Figma MCP upstream contract: " + error.code
        + ". Run npm run login:figma-http, then retry.");
    } else {
      console.error(error instanceof Error ? error.message : error);
    }
    process.exitCode = 1;
  } finally {
    const elapsed = "Elapsed time: "
      + formatFigmaUpstreamContractElapsedTime(performance.now() - startedAt) + ".";
    if (process.exitCode && process.exitCode !== 0) console.error(elapsed);
    else console.log(elapsed);
  }
}

async function checkLiveContract() {
  const expected = await readFigmaUpstreamContractSnapshotFile(acceptedSnapshotPath);
  const client = createRemoteMcpClient({ openBrowser: false });
  try {
    const actual = await createFigmaUpstreamContractSnapshot(client, {
      generatedAt: expected.generatedAt,
      source: expected.source,
    });
    const report = createFigmaUpstreamContractSemanticReport({
      candidateId: "live-check",
      baselineSha256: sha256(serializeFigmaUpstreamContractSnapshot(expected)),
      candidateSnapshotSha256: sha256(serializeFigmaUpstreamContractSnapshot(actual)),
      baseline: expected,
      candidate: actual,
    });
    if (report.entities.length > 0 || report.wrapperCoverage.blocking.length > 0) {
      console.error(formatFigmaUpstreamContractSemanticReport(report));
      console.error("Capture the live state with npm run upstream:contract:capture; do not edit the accepted snapshot directly.");
      process.exitCode = 1;
    } else {
      console.log("Official Figma MCP upstream contract matches " + acceptedSnapshotPath + ".");
    }
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

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
