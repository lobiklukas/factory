/**
 * The `pages` section is a pure function of the pages and the budget (LOB-205, part 2 of LOB-47).
 *
 * These are the rules without a database or a model: what text a page set renders to, which pages
 * survive the cap, and what the drop is called. That the text actually reaches a run's system prompt
 * is asserted where it can be observed — the committed `pi.system` entry and the page-prompt
 * document — in `session.test.ts`, and through the service in `packages/core`'s session suite.
 */
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { Page } from "@repo/domain/Page";
import { describe, expect, it } from "vitest";
import {
  assemblePages,
  PAGES_EXTENSION,
  PAGES_SECTION_KEY,
  PAGES_TOKEN_CAP,
  pagesExtension,
} from "./pages";

const page = (page: Partial<Page> & { readonly name: string }): Page => ({
  kind: "trap",
  content: `what ${page.name} taught`,
  links: [],
  sources: [],
  ...page,
});

/** A body of about 380 tokens: two of them cannot share the default budget, one always fits. */
const bulky = (name: string): string => `${name} `.repeat(750).trim();

/** The rendered section, spelled out the way Pi Durable wraps a section. */
const rendered = (inner: string): string =>
  `<${PAGES_SECTION_KEY}>\n${inner}\n</${PAGES_SECTION_KEY}>`;

describe("the pages section", () => {
  it("renders the pages it carries as one tagged section, exactly", () => {
    const prompt = assemblePages([
      page({
        name: "a-the-log-is-the-truth",
        kind: "decision",
        content: "the log is the truth; the rows are a cache",
        links: ["b-batch-the-fold"],
        sources: ["ses_0000000000aaaaaa"],
      }),
      page({
        name: "b-batch-the-fold",
        content: "a per-batch delete clobbers another batch's rows",
      }),
    ]);

    // The exact text, not a pattern: this is what the model is sent inside `<pages>…</pages>`, and a
    // session's prompt is the thing the acceptance criterion is about.
    expect(prompt.text).toBe(
      [
        "## a-the-log-is-the-truth (decision)",
        "the log is the truth; the rows are a cache",
        "links: b-batch-the-fold",
        "sources: ses_0000000000aaaaaa",
        "",
        "## b-batch-the-fold (trap)",
        "a per-batch delete clobbers another batch's rows",
      ].join("\n"),
    );
    expect(prompt.included).toEqual([
      "a-the-log-is-the-truth",
      "b-batch-the-fold",
    ]);
    expect(prompt.dropped).toEqual([]);
    // Measured with the estimator the compaction policy uses, tag included: that is the cost the
    // budget is about, so the number is what a transcript budget would charge for the same text.
    expect(prompt.tokens).toBe(estimateTextTokens(rendered(prompt.text ?? "")));
    expect(prompt.tokens).toBeLessThanOrEqual(PAGES_TOKEN_CAP);
  });

  it("cuts at the first page the budget cannot hold, and names what it left out", () => {
    const prompt = assemblePages([
      // Oldest, and only a line long: under a size-driven rule it would take the space a newer page
      // could not, which is exactly the rule the issue does not ask for.
      page({
        name: "a-old-note",
        content: "an old one-liner",
        sources: ["ses_0000000000000000"],
      }),
      // Newer, and too big for what is left after the newest note.
      page({
        name: "b-new-bulk",
        content: bulky("new"),
        sources: ["ses_0000000000000001"],
      }),
      page({
        name: "c-newest-note",
        content: "the newest one-liner",
        sources: ["ses_0000000000000002"],
      }),
    ]);

    // Newest first, then a prefix cut: `b-new-bulk` does not fit, so nothing ranked after it goes in
    // — not even the small old page, which would otherwise displace it.
    expect(prompt.included).toEqual(["c-newest-note"]);
    expect(prompt.dropped).toEqual(["b-new-bulk", "a-old-note"]);
    expect(prompt.tokens).toBeLessThanOrEqual(PAGES_TOKEN_CAP);
    // Truncated to the budget, not past it, and the text is the included page alone: what was left
    // out exists in `dropped`, so a caller that records it can say what the run did not receive.
    expect(prompt.tokens).toBe(estimateTextTokens(rendered(prompt.text ?? "")));
    expect(prompt.text).not.toContain("a-old-note");
    expect(prompt.text).not.toContain("b-new-bulk");
  });

  it("renders no section at all when there is nothing under the cap", () => {
    // Both cases are the same answer — no pages, and no page small enough to fit — because a section
    // that rendered an empty tag would tell a model it received knowledge when it received none.
    expect(assemblePages([])).toEqual({ tokens: 0, included: [], dropped: [] });
    const oversized = assemblePages([
      page({ name: "too-big", content: bulky("big").repeat(4) }),
    ]);
    expect(oversized).toEqual({
      tokens: 0,
      included: [],
      dropped: ["too-big"],
    });
    expect(oversized.text).toBeUndefined();
  });

  it("admits shallow pages before deep ones, and pages caught in a link cycle last", () => {
    const linked = [
      // Two roots, linked by nothing: depth 0, and ordered by name among themselves.
      page({ name: "m-lonely" }),
      page({ name: "z-root", links: ["a-child"] }),
      // One hop from `z-root`: depth 1, so it ranks after both roots despite sorting first.
      page({ name: "a-child" }),
      // A cycle has no root above it, so neither of these can claim a depth at all.
      page({ name: "x-cycle", links: ["y-cycle"] }),
      page({ name: "y-cycle", links: ["x-cycle"] }),
    ];

    const prompt = assemblePages(linked);

    expect(prompt.included).toEqual([
      "m-lonely",
      "z-root",
      "a-child",
      "x-cycle",
      "y-cycle",
    ]);
    expect(prompt.dropped).toEqual([]);
  });

  it("is the extension the session installs, with one section and no text when there are no pages", () => {
    const extension = pagesExtension(assemblePages([page({ name: "a-note" })]));
    expect(extension.name).toBe(PAGES_EXTENSION);
    expect(extension.sections?.map((entry) => entry.key)).toEqual([
      PAGES_SECTION_KEY,
    ]);
    // "No section" is this module's answer, not a second check at the install site: an empty page
    // set assembles to no text, and the section renders that absence.
    expect(assemblePages([]).text).toBeUndefined();
  });
});
