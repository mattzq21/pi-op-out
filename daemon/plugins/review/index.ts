import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerReviews } from "./reviews.ts";
import { registerReviewCommands } from "./commands.ts";

export default function reviews(pi: ExtensionAPI) {
  const session = registerReviews(pi);
  const unsubscribe = pi.events.on("piop:reviews:session", request => { request.session = session; });
  pi.on("session_shutdown", () => { unsubscribe(); });
  registerReviewCommands(pi, session);
}
