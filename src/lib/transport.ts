import type { PiTransport } from "../types";
import { MockTransport } from "./mockTransport";
import { NativeTransport } from "./nativeTransport";

export function createTransport(): PiTransport {
  return "__TAURI_INTERNALS__" in window ? new NativeTransport() : new MockTransport();
}
