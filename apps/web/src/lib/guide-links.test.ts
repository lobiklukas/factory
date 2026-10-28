import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  GUIDE_STEPS,
  GUIDE_URL,
  guideHref,
  type GuideStepId,
} from "./guide-links";

/**
 * The dashboard's links into the getting-started guide point at headings that exist (G1). The guide
 * is a file in the repository, so its headings are readable here: a renamed heading turns a link
 * into a page that opens at the top of the document, and nobody notices until an operator is lost.
 */
const GUIDE = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../docs/getting-started.md",
  ),
  "utf8",
);

/** GitHub's anchor for a heading: lowercase, punctuation dropped, spaces to hyphens. */
const anchorOf = (heading: string): string =>
  heading
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .trim()
    .replace(/ /g, "-");

const headings = GUIDE.split("\n")
  .filter((line) => line.startsWith("## "))
  .map((line) => line.slice(3));

describe("guide links", () => {
  const steps = Object.entries(GUIDE_STEPS) as ReadonlyArray<
    [GuideStepId, (typeof GUIDE_STEPS)[GuideStepId]]
  >;

  it.each(steps)("%s names a heading of the guide", (_id, step) => {
    expect(headings.map(anchorOf)).toContain(step.anchor);
  });

  it.each(steps)("%s says the number its heading carries", (_id, step) => {
    const heading = headings.find((h) => anchorOf(h) === step.anchor) ?? "";
    const number = /^(\d+)\./.exec(heading)?.[1];
    expect(number).toBeDefined();
    expect(step.label).toContain(`step ${number}:`);
  });

  it("links the document at the step's anchor", () => {
    expect(guideHref("repo")).toBe(`${GUIDE_URL}#3-register-a-repository`);
    expect(GUIDE_URL.endsWith("/docs/getting-started.md")).toBe(true);
  });
});
