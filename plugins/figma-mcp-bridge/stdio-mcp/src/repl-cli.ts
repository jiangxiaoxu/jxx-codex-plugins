import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createFigmaReplMcpServer,
  type FigmaReplMcpServerOptions,
} from "./repl-server.js";

export async function runFigmaReplMcpCli(
  options: FigmaReplMcpServerOptions = {},
): Promise<never> {
  const { server, client } = createFigmaReplMcpServer(options);
  const transport = new StdioServerTransport();
  let clientClosePromise: Promise<void> | undefined;
  let cleanupComplete = false;
  let removeStdinCloseHandlers: () => void = () => undefined;
  let exitStarted = false;
  let exitOnTransportClose = true;

  const closeClient = () => {
    clientClosePromise ??= client.close().catch(() => undefined);
    return clientClosePromise;
  };
  const cleanupSignalHandlers = () => {
    if (cleanupComplete) {
      return;
    }
    cleanupComplete = true;
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    removeStdinCloseHandlers();
  };
  const exitAfterClose = (exitCode: number) => {
    if (exitStarted) {
      return;
    }
    exitStarted = true;
    cleanupSignalHandlers();
    void closeClient().finally(() => process.exit(exitCode));
  };
  const closeFromTransport = () => {
    try {
      existingOnClose?.();
    } finally {
      if (exitOnTransportClose) {
        exitAfterClose(0);
      }
    }
  };
  const closeFromSignal = (exitCode: number) => {
    exitAfterClose(exitCode);
  };
  const onSigint = () => {
    closeFromSignal(130);
  };
  const onSigterm = () => {
    closeFromSignal(143);
  };

  const existingOnClose = transport.onclose;
  transport.onclose = closeFromTransport;
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  removeStdinCloseHandlers = closeTransportWhenStdinEnds(transport, () => {
    exitAfterClose(0);
  });

  try {
    await server.connect(transport);
    return await new Promise<never>(() => undefined);
  } catch (error) {
    exitOnTransportClose = false;
    cleanupSignalHandlers();
    await server.close().catch(async () => {
      await transport.close().catch(() => undefined);
    });
    await closeClient();
    throw error;
  }
}

export function isDirectRun(importMetaUrl: string, argv = process.argv): boolean {
  const script = argv[1];
  if (!script) {
    return false;
  }
  return resolve(fileURLToPath(importMetaUrl)) === resolve(script);
}

function closeTransportWhenStdinEnds(
  transport: StdioServerTransport,
  onCloseError: () => void,
): () => void {
  let closeRequested = false;
  const closeTransport = () => {
    if (closeRequested) {
      return;
    }
    closeRequested = true;
    void transport.close().catch(onCloseError);
  };
  process.stdin.once("end", closeTransport);
  process.stdin.once("close", closeTransport);
  return () => {
    process.stdin.off("end", closeTransport);
    process.stdin.off("close", closeTransport);
  };
}
