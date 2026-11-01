import { z } from "zod";
import { nativeCall as call } from "./nativeCall";
import { listen } from "./platform";

const outcomeSchema = z.union([z.object({ accepted: z.literal(true) }), z.object({ accepted: z.literal(false), error: z.string() })]);

export type SubmissionOutcome = z.infer<typeof outcomeSchema>;

const RETRY_MS = 15000;

function reconnected() {
  return new Promise<void>(resolve => {
    let stop: (() => void) | undefined; let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); stop?.(); resolve(); };
    const timer = setTimeout(finish, RETRY_MS);
    void listen("pi://event", ({ payload }) => { if (payload.type === "connection_restored") finish(); }, z.object({ type: z.string().optional() }).catch({}))
      .then(unlisten => { stop = unlisten; if (done) unlisten(); });
  });
}

export async function confirmSubmission(hostId: string, submissionId: string, failed?: (reason: string) => void, open = () => true): Promise<SubmissionOutcome | undefined> {
  while (open()) {
    try { return await call("submission_outcome", { hostId, submissionId }, outcomeSchema); }
    catch (reason) { failed?.(reason instanceof Error ? reason.message : String(reason)); await reconnected(); }
  }
}
