import { describe, expect, it } from "vitest";
import { decodeOrchestrationValue, encodeOrchestrationValue } from "./orchestrationProtocol";

describe("orchestration extension protocol", () => {
  it("round-trips unicode configuration through base64url", () => {
    const value = { active: "réviseur", prompt: "Vérifie ça — dokładnie" };
    expect(decodeOrchestrationValue(encodeOrchestrationValue(value))).toEqual(value);
  });
});
