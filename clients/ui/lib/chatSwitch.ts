import type { Accessor } from "solid-js";
import type { NativeTransport } from "./nativeTransport";
import { preloadChat } from "./useChatSession";

const HOLD_LIMIT = 400;

let latest = 0;

export function switchChat(next: NativeTransport, active: Accessor<NativeTransport>, change: () => void) {
  const request = ++latest;
  const from = active();
  void preloadChat(next, HOLD_LIMIT).then(() => { if (request === latest && active() === from) change(); }).catch(reportError);
}
