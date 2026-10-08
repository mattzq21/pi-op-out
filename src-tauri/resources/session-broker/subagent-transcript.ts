import { createReadStream } from "node:fs";

export async function* transcriptLines(path: string, start = 0) {
  const input = createReadStream(path, { start });
  let pending = Buffer.alloc(0);
  let offset = start;

  try {
    for await (const chunk of input) {
      pending = Buffer.concat([pending, chunk]);
      let end = pending.indexOf(10);

      while (end >= 0) {
        const next = offset + end + 1;
        yield { line: pending.subarray(0, end).toString("utf8"), offset, next };
        pending = pending.subarray(end + 1);
        offset = next;
        end = pending.indexOf(10);
      }
    }

    if (pending.length) yield { line: pending.toString("utf8"), offset, next: offset + pending.length };
  } finally { input.destroy(); }
}
