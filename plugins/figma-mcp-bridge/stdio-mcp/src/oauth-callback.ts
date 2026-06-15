import { createServer, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";

export interface OAuthCallbackServerOptions {
  host: string;
  port: number;
  path: string;
  timeoutMs: number;
  getExpectedState?: () => string | undefined | Promise<string | undefined>;
}

export interface OAuthCallbackServer {
  url: string;
  waitForCode(): Promise<string>;
  close(): Promise<void>;
}

const CLOSED_BEFORE_AUTHORIZATION_MESSAGE =
  "OAuth callback server was closed before authorization completed.";

function sendHtml(
  response: ServerResponse,
  status: number,
  title: string,
  body: string,
): void {
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  response.end(
    `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1><p>${body}</p></body></html>`,
  );
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function startOAuthCallbackServer(
  options: OAuthCallbackServerOptions,
): Promise<OAuthCallbackServer> {
  const callbackUrl = `http://${options.host}:${options.port}${options.path}`;
  let timeout: NodeJS.Timeout | undefined;
  let settled = false;
  let closePromise: Promise<void> | undefined;
  let resolveCode: (code: string) => void;
  let rejectCode: (error: Error) => void;

  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  codePromise.catch(() => undefined);

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", callbackUrl);
      if (url.pathname !== options.path) {
        response.writeHead(404);
        response.end("Not found");
        return;
      }

      const error = url.searchParams.get("error");
      if (error) {
        const description = url.searchParams.get("error_description");
        const message = description ? `${error}: ${description}` : error;
        sendHtml(response, 400, "Authorization failed", message);
        settleWithError(new Error(`OAuth authorization failed: ${message}`));
        return;
      }

      const code = url.searchParams.get("code");
      if (!code) {
        sendHtml(response, 400, "Authorization failed", "Missing authorization code.");
        settleWithError(new Error("OAuth callback did not include a code."));
        return;
      }

      const expectedState = await options.getExpectedState?.();
      const receivedState = url.searchParams.get("state") ?? undefined;
      if (expectedState && receivedState !== expectedState) {
        sendHtml(response, 400, "Authorization failed", "OAuth state mismatch.");
        settleWithError(
          new Error("OAuth callback state did not match the saved state."),
        );
        return;
      }

      sendHtml(
        response,
        200,
        "Authorization complete",
        "You can close this window and return to the terminal.",
      );
      settleWithCode(code);
    } catch (error) {
      if (!settled) {
        if (!response.headersSent) {
          sendHtml(response, 500, "Authorization failed", "Internal callback error.");
        }
        settleWithError(asError(error));
      }
    }
  });

  const clearAuthTimeout = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = undefined;
    }
  };
  const requestClose = () => {
    closePromise ??= closeServer(server);
    return closePromise;
  };
  const settleWithCode = (code: string) => {
    if (settled) {
      return;
    }
    settled = true;
    clearAuthTimeout();
    resolveCode(code);
    requestClose().catch(() => undefined);
  };
  const settleWithError = (error: Error) => {
    if (settled) {
      return;
    }
    settled = true;
    clearAuthTimeout();
    rejectCode(error);
    requestClose().catch(() => undefined);
  };

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  timeout = setTimeout(() => {
    settleWithError(new Error("Timed out waiting for OAuth callback."));
  }, options.timeoutMs);

  return {
    url: callbackUrl,
    waitForCode: () => codePromise,
    close: async () => {
      if (!settled) {
        settleWithError(new Error(CLOSED_BEFORE_AUTHORIZATION_MESSAGE));
      } else {
        clearAuthTimeout();
      }
      await requestClose();
    },
  };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
