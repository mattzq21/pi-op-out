import { describe, expect, it } from "vitest";
import { parseSequencePrompt, sequencePrompt } from "./sequence";

describe("sequence prompts", () => {
  it("round-trips hidden handoff metadata without changing the prompt", () => {
    const value = sequencePrompt("review this", { sequence: "review-chain", step: 1, agent: "reviewer", visible: false });
    expect(parseSequencePrompt(value)).toEqual({ text: "review this", step: { sequence: "review-chain", step: 1, agent: "reviewer", visible: false } });
  });
});
