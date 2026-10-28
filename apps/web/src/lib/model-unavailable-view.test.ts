/**
 * E9: when a session's pinned model is not one this server serves. The disabled composer, the
 * explanation and the Replay action are proven in a browser by `.pi/skills/verify-web` (`model.sh`);
 * these are the cases a screenshot cannot settle: which summaries lock the composer, and what the
 * words name.
 */
import { describe, expect, it } from "vitest";
import {
  modelUnavailableNotice,
  unservedModel,
} from "./model-unavailable-view";

describe("unservedModel", () => {
  it("names the pinned model only when the server says it is not served", () => {
    expect(unservedModel({ model: "faux/faux-1", modelAvailable: false })).toBe(
      "faux/faux-1",
    );
  });

  it("leaves a served model, an unanswered one and a session with no model alone", () => {
    expect(unservedModel({ model: "faux/faux-1", modelAvailable: true })).toBe(
      null,
    );
    // A read that knows no catalog does not say: the composer must not lock on a guess.
    expect(unservedModel({ model: "faux/faux-1" })).toBeNull();
    expect(unservedModel({ modelAvailable: false })).toBeNull();
    expect(unservedModel({ model: "", modelAvailable: false })).toBeNull();
  });
});

describe("modelUnavailableNotice", () => {
  it("names the pinned model, the model the replay runs on, and the button", () => {
    const notice = modelUnavailableNotice("faux/faux-1", "anthropic/claude-x");
    expect(notice.explanation).toContain("faux/faux-1");
    expect(notice.explanation).toContain("does not serve");
    expect(notice.explanation).toContain("anthropic/claude-x");
    expect(notice.replayLabel).toBe("Replay on anthropic/claude-x");
    expect(notice.placeholder).toContain("faux/faux-1");
  });

  it("still offers the replay before the server's default model has been read", () => {
    const notice = modelUnavailableNotice("faux/faux-1", undefined);
    expect(notice.replayLabel).toBe("Replay");
    expect(notice.explanation).toContain("faux/faux-1");
  });
});
