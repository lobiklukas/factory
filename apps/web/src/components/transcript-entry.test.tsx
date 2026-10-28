/**
 * What a transcript row renders for the entries the log holds that nobody said (LOB-273). The
 * browser proof is `.pi/skills/verify-web` (`drive.mjs` counts the prompt's occurrences in the
 * transcript); these pin the row contract so a `title` can never fall through to assistant prose
 * again.
 */
import type { TranscriptEntry } from "@repo/domain/Session";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TranscriptRow } from "./transcript-entry";

const entry = (
  kind: TranscriptEntry["kind"],
  text: string,
): TranscriptEntry => ({ id: "e1", kind, text, toolCalls: [] });

const render = (value: TranscriptEntry) =>
  renderToStaticMarkup(<TranscriptRow entry={value} />);

describe("TranscriptRow", () => {
  it("renders a title entry as nothing, not as the agent's prose", () => {
    const markup = render(entry("title", "Fix the login bug"));
    expect(markup).toBe("");
    expect(markup).not.toContain("Fix the login bug");
  });

  it("renders a text-less system entry as nothing, not a bare divider", () => {
    expect(render(entry("system", ""))).toBe("");
  });

  it("still renders a system entry that carries text as its marker", () => {
    expect(render(entry("system", "policy"))).toContain("system");
  });

  it("still renders the user's message once, in its bubble, and the agent's reply as prose", () => {
    const user = render(entry("user", "Fix the login bug"));
    expect(user.split("Fix the login bug")).toHaveLength(2);
    expect(render(entry("assistant", "On it"))).toContain("On it");
  });

  it("still renders a reset as its marker", () => {
    expect(render(entry("reset", ""))).toContain("reset");
  });
});
