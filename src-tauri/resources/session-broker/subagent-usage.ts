import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { goalTokens } from "./goal-state.ts";

export function watchSubagentUsage(path: string, offset: number, report: (total: number) => void, failed: (error: unknown) => void) {
  const decoder = new StringDecoder("utf8");
  let pendingText = "";
  let total = 0;
  let stopped = false;
  let failure: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = Promise.resolve();
  const consume = (chunk: Buffer) => {
    pendingText += decoder.write(chunk);
    let end: number;
    while ((end = pendingText.indexOf("\n")) >= 0) {
      const line = pendingText.slice(0, end);
      pendingText = pendingText.slice(end + 1);
      total += entryTokens(line);
    }
    report(total);
  };
  const read = async () => {
    const size = (await stat(path)).size;
    if (size < offset) throw new Error("Subagent transcript was truncated during usage accounting");
    if (size === offset) return;
    const input = createReadStream(path, { start: offset, end: size - 1 });
    for await (const chunk of input) { consume(chunk as Buffer); offset += (chunk as Buffer).length; }
  };
  const tick = () => {
    pending = read().catch(error => { failure = error; stopped = true; failed(error); }).then(() => {
      if (!stopped) timer = setTimeout(tick, 250);
    });
  };
  tick();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await pending;
    if (failure) throw failure;
    await read();
  };
}

function entryTokens(line: string) {
  let entry;
  try { entry = JSON.parse(line); } catch { return 0; }
  if (entry.type !== "message") return goalTokens(entry.usage);
  return entry.message?.role === "assistant" ? goalTokens(entry.message.usage) : 0;
}
