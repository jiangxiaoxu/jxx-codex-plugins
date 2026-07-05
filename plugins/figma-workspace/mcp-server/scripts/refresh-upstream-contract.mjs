import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createFigmaUpstreamContractSnapshot,
  createRemoteMcpClient,
  isRemoteMcpOAuthError,
  writeFigmaUpstreamContractSnapshotFile,
} from "../dist/upstream/node-upstream-client.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const snapshotPath = resolve(packageRoot, "tests/fixtures/upstream-contract-snapshot.json");
const client = createRemoteMcpClient({ openBrowser: false });

try {
  const snapshot = await createFigmaUpstreamContractSnapshot(client);
  await writeFigmaUpstreamContractSnapshotFile(snapshotPath, snapshot);
  console.log(`Refreshed official Figma MCP upstream contract snapshot: ${snapshotPath}`);
} catch (error) {
  if (isRemoteMcpOAuthError(error)) {
    console.error(
      `Unable to refresh official Figma MCP upstream contract snapshot: ${error.code}. Run npm run login:figma-http, then retry npm run upstream:contract:refresh.`,
    );
  } else {
    console.error("Unable to refresh official Figma MCP upstream contract snapshot.");
    console.error(error);
  }
  process.exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
}
