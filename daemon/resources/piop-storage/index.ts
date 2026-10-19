import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SessionStorage } from "./interface.ts";

import { read, write, known } from "./goals.cjs";

export default function storage(pi: ExtensionAPI) {
  const session: SessionStorage = {
    readGoal: read,
    knownGoal: known,
    writeGoal: write,
    append(type, data) {
      if (!type.trim()) throw new Error("Session record type is missing");
      pi.appendEntry(type, structuredClone(data));
    },
  };
  pi.events.on("piop:storage:session", request => { request.storage = session; });
}
