import {
  ReadableStream as NodeReadableStream,
  TransformStream as NodeTransformStream,
  WritableStream as NodeWritableStream,
} from "node:stream/web";

installGlobal("ReadableStream", NodeReadableStream);
installGlobal("TransformStream", NodeTransformStream);
installGlobal("WritableStream", NodeWritableStream);

function installGlobal(name: string, value: object): void {
  if (Reflect.get(globalThis, name) === undefined) {
    Reflect.set(globalThis, name, value);
  }
}
