import {
  ReadableStream as NodeReadableStream,
  TransformStream as NodeTransformStream,
  WritableStream as NodeWritableStream,
} from "node:stream/web";

export function installNodeReplWebStreamGlobals(): void {
  installGlobal("ReadableStream", NodeReadableStream);
  installGlobal("TransformStream", NodeTransformStream);
  installGlobal("WritableStream", NodeWritableStream);
}

function installGlobal(name: string, value: object): void {
  if (Reflect.get(globalThis, name) === undefined) {
    Reflect.set(globalThis, name, value);
  }
}

installNodeReplWebStreamGlobals();

const clientModule: typeof import("./client.js") = await import("./client.js");

export const RemoteMcpClient = clientModule.RemoteMcpClient;
export const createRemoteMcpClient = clientModule.createRemoteMcpClient;
export type { RemoteMcpClientOptions } from "./client.js";
