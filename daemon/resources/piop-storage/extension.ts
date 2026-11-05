import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SessionStorage } from "./interface.ts";

export default function storage(pi: ExtensionAPI) {
  const session: SessionStorage = {
    append(type, data) {
      if (!type.trim()) throw new Error("Session record type is missing");
      pi.appendEntry(type, structuredClone(data));
    },
  };
  pi.events.on("piop:storage:session", request => { request.storage = session; });
}
