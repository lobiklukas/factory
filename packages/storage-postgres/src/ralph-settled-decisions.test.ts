import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * No instruction in the repo may name the settled decisions as a *range* (LOB-127).
 *
 * `docs/design.md` numbers its decisions `### D1 …` … `### D17 …`, and the range used to be
 * written out in eight places — `AGENTS.md`, `.pi/ralph/work.prompt.md`, both `ralph-*` agent
 * briefs, `docs/roadmap.md`, `docs/features.md` (twice) and `docs/handoff.md`. Every one of them
 * said `D1-D16` while D17 existed, and two of them are *binding* text: `.pi/ralph/work.prompt.md`
 * tells a worker "`docs/design.md` decisions (D1-D16) are settled", which is a sentence that
 * silently excludes the newest decision from the settled set. A range is also self-breaking — the
 * next decision re-breaks all eight sites, and nothing notices until a worker reads D18 as open.
 *
 * So the sites now say "the settled decisions in `docs/design.md`" and name no numbers, and this
 * file is what keeps them that way. It reads the highest decision number out of `docs/design.md`
 * and reddens on any range in an instruction whose top end is below it. A range that already
 * reaches the top (`README.md:114`, `docs/README.md:3,11` say `D1-D17`) is not a finding; a
 * range that names the top decision elsewhere on the same line is not a finding either — that is
 * the shape `docs/board.md` used to acknowledge D17 before this file made even that unnecessary.
 *
 * What this can prove: that no shipped instruction understates the settled set, and that it still
 * holds after the next decision is appended to `docs/design.md`. What it cannot prove: that the
 * *wording* at each site is the range-free wording — only that no stale range survives. A site
 * could still say "the older decisions" and stay green; that is a prose judgement no scan makes.
 *
 * The corpus is the trees that instruct an agent, walked in full, plus the root `README.md` — the
 * one instruction file outside them. `.ralph/` and `.verify/` are deliberately absent: both are
 * gitignored run state (`.gitignore`), not instructions, and both quote the stale range as part of
 * a bug report (`.ralph/plan.md`'s LOB-127 row, `.ralph/sessions/subagent-artifacts/*`). The
 * acceptance's literal `grep -rn … .` over the working tree therefore cannot be the check: it
 * matches evidence and plan state that never ships. Scanning the repository's own trees is the
 * honest reading of "returns nothing outside `.git/` and `node_modules/`" — nothing *in the repo*.
 *
 * The file lives in `@repo/storage-postgres` for the same reason `ralph-linear-calls.test.ts`,
 * `turbo-env.test.ts` and `postgres-up.test.ts` do: it is a repo-level claim that belongs to no
 * package, and it needs no database and no container to run.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** Where the decisions are numbered, and what a heading looks like there. */
const DESIGN_DOC = "docs/design.md";
const DECISION_HEADING = /^### D(\d+)\b/;

/** `D1-D16`, `D1–D16`, `D1—D16` — a range with both ends written out. */
const RANGE = /D(\d+)\s*[–—-]\s*D(\d+)/g;

interface Source {
  readonly path: string;
  readonly text: string;
}

/** The highest decision number `docs/design.md` declares, or `0` if it declares none. */
function highestDecision(text: string): number {
  let highest = 0;
  for (const line of text.split("\n")) {
    const match = DECISION_HEADING.exec(line);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest;
}

/**
 * Every range in `text` whose top end is below `highest`, as `<line>: <range>`.
 *
 * A line that also names the top decision is exempt: it is a range *plus* the acknowledgement
 * that the set runs further, which is a true sentence rather than an understated one. `docs/board.md`
 * was the one site written that way before LOB-127 made it range-free too.
 */
function staleRanges(text: string, highest: number): string[] {
  const out: string[] = [];
  text.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(RANGE)) {
      const top = Number(match[2]);
      if (top >= highest) continue;
      if (line.includes(`D${highest}`)) continue;
      out.push(`${index + 1}: ${match[0]}`);
    }
  });
  return out;
}

/** Every stale range in a source, as `<path>:<line>: <range>`. */
function findings(sources: readonly Source[], highest: number): string[] {
  const out: string[] = [];
  for (const source of sources) {
    for (const entry of staleRanges(source.text, highest)) {
      out.push(`${source.path}:${entry}`);
    }
  }
  return out;
}

/**
 * The corpus, read from disk: every Markdown file under `CORPUS_DIRS`, plus the root `README.md`.
 *
 * Walked rather than enumerated from `git ls-files` so that an instruction file someone forgot to
 * stage is still scanned — the walk sees the working tree, which is what a reader reads.
 */
function corpus(): Source[] {
  const read = (relative: string): Source => ({
    path: relative,
    text: readFileSync(path.join(REPO_ROOT, relative), "utf8"),
  });
  const walk = (dir: string): string[] =>
    readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true }).flatMap(
      (entry) => {
        const relative = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(relative);
        return entry.name.endsWith(".md") ? [relative] : [];
      },
    );
  const roots = readdirSync(REPO_ROOT, { withFileTypes: true })
    .filter((entry) => !entry.isDirectory() && entry.name.endsWith(".md"))
    .map((entry) => entry.name);
  return [...CORPUS_DIRS.flatMap(walk), ...roots].map(read);
}

/** The trees that instruct an agent. `docs/` and `.pi/` are the whole of the shipped instruction set. */
const CORPUS_DIRS = [".pi", "docs"];

describe("the instructions' settled-decisions range", () => {
  // Mutation checked: appending a `### D18 —` heading to `docs/design.md` reddens this one —
  // every `D1-D17` range in the corpus (`README.md:114`, `docs/README.md:3,11`) then understates
  // the set. The case below is the same regression against a synthetic corpus, so the proof does
  // not depend on those two files keeping their ranges. This is the regression LOB-127 exists to
  // catch.
  it("names no range below the highest decision in docs/design.md", () => {
    const design = readFileSync(path.join(REPO_ROOT, DESIGN_DOC), "utf8");
    const highest = highestDecision(design);
    expect(highest).toBeGreaterThan(0);
    expect(findings(corpus(), highest)).toEqual([]);
  });

  // Mutation checked: raising the highest decision the corpus is compared against — exactly what
  // appending `### D18 —` to `docs/design.md` does — reddens this one, because the `D1-D17`
  // range then understates the set. LOB-127's second acceptance criterion, proven without touching
  // the real `docs/design.md` or depending on which ranges the corpus happens to carry.
  it("reddens when a decision is appended and the instructions are not updated", () => {
    const source: Source = {
      path: "synthetic.md",
      text: "`docs/design.md` holds the settled decisions (D1-D17) and their rationale.\n",
    };
    expect(findings([source], 17)).toEqual([]);
    expect(findings([source], 18)).toEqual(["synthetic.md:1: D1-D17"]);
  });

  // Mutation checked: pointing `CORPUS_DIRS` at one directory, or dropping `docs/` from it, which
  // would make the case above a check of a hand-picked subtree rather than of every instruction.
  it("scans every tree that instructs an agent", () => {
    const paths = corpus().map((source) => source.path);
    for (const path of [
      "AGENTS.md",
      "README.md",
      ".pi/agents/ralph-reviewer.md",
      ".pi/ralph/work.prompt.md",
      ".pi/skills/verify-api/SKILL.md",
      "docs/board.md",
      "docs/design.md",
      "docs/features.md",
      "docs/handoff.md",
      "docs/roadmap.md",
    ]) {
      expect(paths).toContain(path);
    }
  });

  // Mutation checked: making `staleRanges` skip the `top >= highest` comparison, so a range that
  // already reaches the top is exempt — `README.md:114` and `docs/README.md:3,11` say `D1-D17`
  // and are correct today. Without this case the rule could pass by flagging them.
  it("accepts a range that already reaches the highest decision", () => {
    const source: Source = {
      path: "synthetic.md",
      text: "`design.md` holds the settled decisions (D1-D17) and their rationale.\n",
    };
    expect(findings([source], 17)).toEqual([]);
  });

  // Mutation checked: dropping the `D${highest}` exemption, which is what lets a line carry a
  // range *and* the acknowledgement that the set runs further. `docs/board.md:5` was written that
  // way — "(D1–D16, plus D17 which introduces it)" — and it was a true sentence.
  it("accepts a range that names the highest decision on the same line", () => {
    const source: Source = {
      path: "synthetic.md",
      text: "the board rests on (D1–D16, plus D17 which introduces it);\n",
    };
    expect(findings([source], 17)).toEqual([]);
  });

  // Mutation checked: dropping the `top >= highest` guard. It looks redundant next to the case
  // above — every range that reaches the top also names it — and it is not: a range that
  // *overshoots* (`D1-D18` while the top is 17) names no top decision, so without the guard it
  // would red. It is exempt on purpose. LOB-127 is about instructions that understate the settled
  // set; an overshooting range is a different error, and a guard that flags it would red on a
  // line that is merely wrong in the other direction.
  it("does not read a range above the highest as an understatement", () => {
    const source: Source = {
      path: "synthetic.md",
      text: "the decisions run D1-D18, one past the top.\n",
    };
    expect(findings([source], 17)).toEqual([]);
  });

  // Mutation checked: making `staleRanges` return nothing, or `highestDecision` return a number
  // below the real one. Both leave the first case green while the rule is inert.
  it("reddens on the range that is stale today", () => {
    const source: Source = {
      path: "synthetic.md",
      text: "`docs/design.md` decisions (D1-D16) are settled.\n",
    };
    expect(findings([source], 17)).toEqual(["synthetic.md:1: D1-D16"]);
  });

  // Mutation checked: reading the decision number from the wrong capture group, or matching a
  // single decision reference instead of a range. `D17` alone is not a range and must not red.
  it("ignores a single decision reference and a range above the highest", () => {
    const sources: Source[] = [
      { path: "synthetic.md", text: "D17 introduces the board.\n" },
      {
        path: "synthetic.md",
        text: "the decisions run D1-D17 and no further.\n",
      },
    ];
    expect(findings(sources, 17)).toEqual([]);
  });

  // Mutation checked: narrowing `RANGE` to the hyphen only, so the en-dash form `D1–D16` — the one
  // `AGENTS.md`, `docs/roadmap.md`, `docs/features.md` and `docs/handoff.md` actually used — would
  // pass unnoticed.
  it("catches the en-dash and em-dash forms of the range", () => {
    for (const line of [
      "the settled decisions (D1–D16)",
      "the settled decisions (D1—D16)",
      "the settled decisions (D1-D16)",
    ]) {
      expect(
        findings([{ path: "synthetic.md", text: line + "\n" }], 17),
      ).toEqual([
        `synthetic.md:1: ${line.slice(line.indexOf("D1"), line.indexOf("D1") + 6)}`,
      ]);
    }
  });

  // Mutation checked: making `highestDecision` return `0` unconditionally, which would exempt every
  // range at once. The assertion is the reader's own tripwire.
  it("reads a highest decision that is not zero", () => {
    expect(highestDecision("### D1 — one\n### D17 — seventeen\n")).toBe(17);
    expect(highestDecision("### D1 — one\n")).toBe(1);
    expect(highestDecision("no decisions here\n")).toBe(0);
  });
});
