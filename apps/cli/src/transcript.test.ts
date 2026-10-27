/**
 * The queued line `factory watch` prints (LOB-166). It is the only place a terminal user learns the
 * submission id `factory withdraw` takes, so the id is part of the line's contract.
 */
import { describe, expect, it } from "vitest";
import { formatQueued } from "./transcript";

describe("formatQueued", () => {
  it("names the queue and the submission id, then the text", () => {
    expect(formatQueued({ id: "12", mode: "steer", content: "steer me" })).toBe(
      "[queued:steer:12] steer me",
    );
  });

  it("prints structured content as JSON and absent content as nothing", () => {
    expect(
      formatQueued({
        id: "3",
        mode: "followUp",
        content: [{ type: "text", text: "hi" }],
      }),
    ).toBe('[queued:followUp:3] [{"type":"text","text":"hi"}]');
    expect(formatQueued({ id: "4", mode: "write" })).toBe("[queued:write:4]");
  });
});
