import {
  isDirectRun,
  startFigmaStdioMcpServer,
} from "./stdio-server.js";

if (isDirectRun(import.meta.url)) {
  await startFigmaStdioMcpServer({
    useBridgeOAuthCache: true,
    openBrowser: false,
  });
}
