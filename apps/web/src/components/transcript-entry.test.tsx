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

  it("puts a budget stop's action under it, and no other row's (C23)", () => {
    const stop = entry("budget", "budget reached: stopped");
    const withAction = renderToStaticMarkup(
      <TranscriptRow entry={stop} action={<button>Raise cap</button>} />,
    );
    expect(withAction).toContain("budget reached: stopped");
    expect(withAction.indexOf("Raise cap")).toBeGreaterThan(
      withAction.indexOf("budget reached: stopped"),
    );
    expect(render(stop)).not.toContain("Raise cap");
    const other = renderToStaticMarkup(
      <TranscriptRow
        entry={entry("assistant", "On it")}
        action={<button>Raise cap</button>}
      />,
    );
    expect(other).not.toContain("Raise cap");
  });

  it("still renders the user's message once, in its bubble, and the agent's reply as prose", () => {
    const user = render(entry("user", "Fix the login bug"));
    expect(user.split("Fix the login bug")).toHaveLength(2);
    expect(render(entry("assistant", "On it"))).toContain("On it");
  });

  it("still renders a reset as its marker", () => {
    expect(render(entry("reset", ""))).toContain("reset");
  });

  it("renders an interrupt as a status marker with its line, not as the agent's prose (C8)", () => {
    const line = "interrupted: the run was stopped before it finished";
    const markup = render(entry("interrupted", line));
    expect(markup).toContain('data-entry-kind="interrupted"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain(line);
    expect(markup).not.toBe(render(entry("assistant", line)));
  });

  it("renders a model switch as a status marker with its line, not as the agent's prose (S-model-provider-breadth)", () => {
    const line =
      "model switch: faux/faux-1 is unavailable (529 overloaded_error), so the retried request and every later one go to openai-compatible/compat-1";
    const markup = render(entry("modelSwitch", line));
    expect(markup).toContain('data-entry-kind="modelSwitch"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain(line);
    expect(markup).not.toBe(render(entry("assistant", line)));
  });
});
