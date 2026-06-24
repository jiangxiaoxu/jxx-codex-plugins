import type { RemoteMcpClientOptions } from "./client.js";
import type { FigmaReplClientOptions } from "./repl-server.js";
export declare function installNodeReplWebStreamGlobals(): void;
declare const clientModule: typeof import("./client.js"), replServerModule: typeof import("./repl-server.js");
export declare const RemoteMcpClient: typeof import("./client.js").RemoteMcpClient;
export declare function createRemoteMcpClient(options?: RemoteMcpClientOptions): ReturnType<typeof clientModule.createRemoteMcpClient>;
export declare function createFigmaReplClient(options?: FigmaReplClientOptions): ReturnType<typeof replServerModule.createFigmaReplClient>;
export type { RemoteMcpClientOptions } from "./client.js";
export type { FigmaReplClient, FigmaReplClientOptions, } from "./repl-server.js";
