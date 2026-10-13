import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerReviews } from "./reviews.ts";
import { registerReviewCommands } from "./commands.ts";

/** Code reviews: review conversations linked to this conversation, /review, /rs and Piop review requests. Publishes ReviewSession on "piop:reviews:session". */
export default function reviews(pi: ExtensionAPI) {
  const session = registerReviews(pi);
  const unsubscribe = pi.events.on("piop:reviews:session", request => { request.session = session; });
  pi.on("session_shutdown", () => { unsubscribe(); });
  registerReviewCommands(pi, session);
}
