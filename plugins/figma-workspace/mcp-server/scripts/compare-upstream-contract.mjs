import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  createFigmaUpstreamContractSnapshot,
  createRemoteMcpClient,
  diffFigmaUpstreamContractSnapshots,
  formatFigmaUpstreamContractDrift,
  formatFigmaUpstreamContractElapsedTime,
  isRemoteMcpOAuthError,
  readFigmaUpstreamContractSnapshotFile,
} from "../dist/upstream/node-upstream-client.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const snapshotPath = resolve(packageRoot, "tests/fixtures/upstream-contract-snapshot.json");
const refreshCommand = "npm run upstream:contract:refresh";

const startedAt = performance.now();
const expected = await readFigmaUpstreamContractSnapshotFile(snapshotPath);
const client = createRemoteMcpClient({ openBrowser: false });

try {
  const actual = await createFigmaUpstreamContractSnapshot(client, {
    generatedAt: expected.generatedAt,
    source: expected.source,
  });
  const drift = diffFigmaUpstreamContractSnapshots(expected, actual);
  if (drift.length > 0) {
    console.error(formatFigmaUpstreamContractDrift(drift, {
      snapshotPath,
      refreshCommand,
    }));
    process.exitCode = 1;
  } else {
    console.log(`Official Figma MCP upstream contract matches ${snapshotPath}.`);
  }
} catch (error) {
  if (isRemoteMcpOAuthError(error)) {
    console.error(
      `Unable to compare official Figma MCP upstream contract: ${error.code}. Run npm run login:figma-http, then retry ${refreshCommand} or npm run upstream:contract:check.`,
    );
  } else {
    console.error("Unable to compare official Figma MCP upstream contract.");
    console.error(error);
  }
  process.exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
  const elapsed = `Elapsed time: ${formatFigmaUpstreamContractElapsedTime(performance.now() - startedAt)}.`;
  if (process.exitCode && process.exitCode !== 0) {
    console.error(elapsed);
  } else {
    console.log(elapsed);
  }
}
