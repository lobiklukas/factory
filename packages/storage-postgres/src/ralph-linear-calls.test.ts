import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every place the loop's own instructions show a `save_comment` call must name the create-form
 * argument `issueId` (LOB-118).
 *
 * The Linear MCP tool's `id` means *update that existing comment*; `get_issue` and `save_issue` take
 * `id` for the issue, so passing one to `save_comment` reads as the same thing and is not. An `id`
 * that names no comment answers `400 Could not find referenced Comment` and posts nothing; one that
 * names a comment overwrites that comment with your body. Nothing in the *loop's prompts* said which
 * argument a create takes — `.pi/ralph/work.prompt.md`'s tool list named `get_issue({ id, … })` and
 * then `save_comment` bare — so an iteration that guessed `id` lost its `ralph: picked up` or
 * PR-link comment silently: the 400 arrives as tool content with `isError: true`, not as a thrown
 * error, so no gate, no log line and no failed tool call noticed it. (`docs/next-agent.md` did name
 * `issueId`, but it is the handoff brief, not what a worker reads.) The call sites now spell the
 * argument out; this file is what keeps them.
 *
 * A "call site" is a line that names the tool and carries a `{`, in either of the two shapes below:
 * the ordinary one, where the argument object opens on the same line, and a call a line wrapper broke
 * in two. Prose that names the tool without a brace is exempt, which is deliberate — the explanation
 * beside the fix has to be able to name the wrong argument in order to warn about it. Two false reds
 * are accepted rather than papered over: documenting the *update* form (`save_comment` with an `id`
 * edits an existing comment) reddens, and so does prose that names the tool and shows its result
 * shape on one line. Narrowing the rule to the tool immediately followed by `(` would drop
 * `docs/next-agent.md`'s JSON shape, which is a real instruction, so the rule stays broad.
 *
 * What this can prove: that our instructions hand the agent the argument the server needs, and that
 * they still do after the next edit to a prompt. What it cannot prove: that the hosted server accepts
 * the call. Only a real call does that, and no test may make one (`docs/testing-third-parties.md`).
 * The live half was run by hand on 2026-10-06 and recorded under `.verify/evidence/lob-118/`.
 *
 * The file lives in `@repo/storage-postgres` for the same reason `turbo-env.test.ts`,
 * `postgres-up.test.ts` and `ralph-docker-env.test.ts` do: it is a repo-level claim that belongs to no
 * package, and it needs no database and no container to run. It reads every Markdown file under
 * `.pi/` and `docs/`, plus the root `AGENTS.md` — every tree that instructs an agent.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * The trees that instruct an agent, walked in full. `.ralph/` is deliberately *not* here: it is the
 * loop's run state, and `.ralph/plan.md`'s LOB-118 row quotes the failing call as part of the bug
 * report — a historical record, not an instruction, and one this guard would false-red on.
 */
const CORPUS_DIRS = [".pi", "docs"];

/** The instruction file that sits outside both trees. */
const CORPUS_FILES = ["AGENTS.md"];

const TOOL = "save_comment";

/** The argument the server needs to create a comment; `id` would update an existing one instead. */
const CREATE_ARGUMENT = "issueId";

/**
 * How many lines before one a call's argument object can sit. One is the wrap a line wrapper produces;
 * two is the furthest a prompt is likely to stretch. Wider than that and the rule starts reading an
 * unrelated `{` on a nearby line as the call's own.
 */
const WRAP_WINDOW = 2;

/** A line that opens a call and closes nothing, so its argument object sits on a later line. */
const OPENS_CALL = /save_comment\s*\(\s*$/;

interface Source {
  readonly path: string;
  readonly text: string;
}

/**
 * A line that shows the tool's arguments, as opposed to prose that only names it.
 *
 * The ordinary shape names the tool and opens the argument object on the same line. The other is a
 * call a line wrapper broke in two — `save_comment(` with nothing after it, the object on the next
 * line — which the first rule alone reads as prose, and which a long call inside a prompt comes out
 * as. The wrapper has to be *open* for the second rule to fire: `.pi/ralph/work.prompt.md` puts a `{`
 * on the line after a `save_comment` mention, and that line is the tool's result shape, not a call.
 */
const isCallSite = (line: string, before: readonly string[]): boolean =>
  (line.includes(TOOL) && line.includes("{")) ||
  (line.includes("{") && before.some((l) => OPENS_CALL.test(l)));

/**
 * A source's call sites as `<line number>: <text>`, in file order. Both rules are applied here, so
 * `callSites` and `findings` cannot disagree about what a call site is.
 */
function scan(source: Source): string[] {
  const lines = source.text.split("\n");
  const out: string[] = [];
  lines.forEach((line, index) => {
    if (
      isCallSite(line, lines.slice(Math.max(0, index - WRAP_WINDOW), index))
    ) {
      out.push(`${index + 1}: ${line.trim()}`);
    }
  });
  return out;
}

/** The text of a source's call sites, without their line numbers. */
const callSites = (source: Source): string[] =>
  scan(source).map((entry) => entry.replace(/^\d+: /, ""));

/**
 * Every call site that does not name `issueId`, as `<path>:<line>: <text>`. An empty list is the
 * contract: the instructions never show the call that fails.
 */
function findings(sources: readonly Source[]): string[] {
  const out: string[] = [];
  for (const source of sources) {
    for (const entry of scan(source)) {
      if (entry.includes(CREATE_ARGUMENT)) continue;
      out.push(`${source.path}:${entry}`);
    }
  }
  return out;
}

/**
 * The corpus, read from disk: every Markdown file under `CORPUS_DIRS`, plus `CORPUS_FILES`.
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
  return [...CORPUS_DIRS.flatMap(walk), ...CORPUS_FILES].map(read);
}

/**
 * Every file that must show the call, and how many call sites it must keep.
 *
 * A count per file rather than a set of files, because the regression that matters is a *partial*
 * one: reverting the bare `save_comment` into `.pi/ralph/work.prompt.md`'s step 3 leaves that file's
 * other three call sites in place, so a set-membership check stays green while the `ralph: picked
 * up` comment — the one this issue is about — is lost again.
 *
 * Files that merely *mention* the tool are not listed and not pinned: `docs/testing-third-parties.md`
 * carries a `{` on its Linear MCP row because the row quotes the 400 payload, and whether that row is
 * a call site at all is an accident of its wording. Case 1 still scans it; this map only pins the
 * files that call the tool on purpose.
 */
const CALLING_FILES: Record<string, number> = {
  ".pi/ralph/close.prompt.md": 1,
  ".pi/ralph/plan.prompt.md": 1,
  ".pi/ralph/split.prompt.md": 1,
  ".pi/ralph/ticket.md": 1,
  ".pi/ralph/work.prompt.md": 4,
  "docs/next-agent.md": 1,
};

/**
 * What the map above must add up to, as a literal. Without it, emptying the map would make the loop
 * in the case below vacuous — the same hole a literal `CALLING_FILES` array had before it.
 */
const TOTAL_CALL_SITES = 9;

describe("the loop's save_comment call sites", () => {
  // Mutation checked: deleting `issueId` from any call site in the corpus (the case below does it to
  // `work.prompt.md`) reddens this one and names the file and line.
  it("names issueId at every call site in the instructions", () => {
    expect(findings(corpus())).toEqual([]);
  });

  // Mutation checked: dropping one call site from a file that has several — the partial regression a
  // set of files cannot see — or emptying a corpus directory, or emptying `CALLING_FILES` itself.
  // This is the reason the case above cannot pass by finding nothing, and the reason a file that
  // keeps three of its four call sites still reddens.
  it("reads a corpus that still holds every call site", () => {
    const counts = new Map(
      corpus().map((source) => [source.path, callSites(source).length]),
    );
    for (const [file, expected] of Object.entries(CALLING_FILES)) {
      expect(counts.get(file) ?? 0, `${file}: save_comment call sites`).toBe(
        expected,
      );
    }
    // The fixture itself is pinned to a literal, so emptying it cannot make the loop vacuous.
    expect(Object.values(CALLING_FILES).reduce((a, b) => a + b, 0)).toBe(
      TOTAL_CALL_SITES,
    );
  });

  // Mutation checked: `save_comment({ issueId, body })` -> `save_comment({ id, body })` at every
  // call site of the file the worker reads. The mutation is synthetic — the pre-fix prompt named no
  // argument object at all, which only the count case above can see — and it is the reason the first
  // case is not a tautology.
  it("reddens when a real prompt's call sites lose the argument", () => {
    const file = ".pi/ralph/work.prompt.md";
    const text = readFileSync(path.join(REPO_ROOT, file), "utf8");
    const mutated = text.replaceAll(CREATE_ARGUMENT, "id");
    expect(mutated).not.toBe(text);
    const found = findings([{ path: file, text: mutated }]);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((line) => line.startsWith(`${file}:`))).toBe(true);
  });

  // Mutation checked: making the checker accept a call site that names `id` instead of `issueId`.
  it("reddens on the exact call that failed, and passes the one that works", () => {
    const wrong: Source = {
      path: "synthetic.md",
      text: 'await tools.mcp__linear__save_comment({ id: "LOB-118", body: "hi" });',
    };
    expect(findings([wrong])).toHaveLength(1);

    const right: Source = {
      path: "synthetic.md",
      text: 'await tools.mcp__linear__save_comment({ issueId: "LOB-118", body: "hi" });',
    };
    expect(findings([right])).toEqual([]);
  });

  // Mutation checked: dropping the `{` from `isCallSite`, which would exempt every real call site.
  it("exempts prose that names the tool without showing its arguments", () => {
    const prose: Source = {
      path: "synthetic.md",
      text: "`save_comment`'s `id` updates an existing comment, so always pass the issue's identifier.",
    };
    expect(callSites(prose)).toEqual([]);
    expect(findings([prose])).toEqual([]);
  });

  // Mutation checked: dropping the second disjunct of `isCallSite` — the wrapped-call rule — which
  // exempts a real call a line wrapper broke in two. The first draft of this file missed this:
  // `save_comment(` on one line and `{ id, body }` on the next read as prose, so a prompt could show
  // the failing call and stay green.
  it("reddens on a wrapped call whose argument object is on the next line", () => {
    const wrong: Source = {
      path: "synthetic.md",
      text: 'await tools.mcp__linear__save_comment(\n  { id: "LOB-118", body: "hi" },\n);\n',
    };
    expect(findings([wrong])).toEqual([
      'synthetic.md:2: { id: "LOB-118", body: "hi" },',
    ]);

    const right: Source = {
      path: "synthetic.md",
      text: 'await tools.mcp__linear__save_comment(\n  { issueId: "LOB-118", body: "hi" },\n);\n',
    };
    expect(findings([right])).toEqual([]);
  });

  // Mutation checked: loosening the wrapped-call rule from "the previous line opens the call" to
  // "the previous line mentions the tool". `.pi/ralph/work.prompt.md:17` is exactly that near miss —
  // a `{` on the line after a `save_comment` mention, and it is the tool's *result* shape. A rule
  // that flags it false-reds on the prompt this guard exists to protect.
  it("does not read a result shape as a wrapped call", () => {
    const nearMiss: Source = {
      path: "synthetic.md",
      text:
        "  `save_issue`, `save_comment({ issueId, body })`, `list_issues`. Results are\n" +
        '  { content: [{ type: "text", text: "<json>" }] } - `JSON.parse(res.content[0].text)`.\n',
    };
    expect(callSites(nearMiss)).toEqual([
      "`save_issue`, `save_comment({ issueId, body })`, `list_issues`. Results are",
    ]);
    expect(findings([nearMiss])).toEqual([]);
  });

  // Mutation checked: making the argument test a whole-line `includes` that an unrelated `issueId`
  // anywhere on the line satisfies. Markdown gives a wrong call several places to hide — an HTML
  // comment, a table cell, a fenced block, a space before the paren — and each is still the call
  // that 400s.
  it("catches the wrong call in every shape markdown writes it in", () => {
    const wrong = [
      "<!-- save_comment({ id, body }) -->",
      "| `save_comment({ id, body })` |",
      "```save_comment({ id, body })```",
      'save_comment ({ id: "LOB-118", body: "hi" })',
      'await tools.mcp__linear__save_comment({ id: "LOB-118", body: "hi" });',
      'save_comment({"id": "LOB-118", "body": "hi"})',
    ];
    for (const line of wrong) {
      expect(
        findings([{ path: "synthetic.md", text: line + "\n" }]),
      ).toHaveLength(1);
    }

    const right = [
      "save_comment({issueId,body})",
      "save_comment ({ issueId, body })",
      "save_comment({ issueId: issue.id, body })",
      'await tools.mcp__linear__save_comment({ issueId: "LOB-118", body: "hi" });',
    ];
    for (const line of right) {
      expect(findings([{ path: "synthetic.md", text: line + "\n" }])).toEqual(
        [],
      );
    }
  });

  // Mutation checked: pointing `CORPUS_DIRS` at the calling files only, or dropping a tree from it,
  // which would make the first case a check of a hand-picked list rather than of every tree that
  // instructs an agent.
  it("scans the trees that instruct an agent, not only the files that must carry a call site", () => {
    const paths = corpus().map((source) => source.path);
    expect(paths.length).toBeGreaterThan(Object.keys(CALLING_FILES).length);
    for (const path of [
      "AGENTS.md",
      ".pi/agents/ralph-reviewer.md",
      ".pi/ralph/audit.prompt.md",
      ".pi/skills/verify-api/SKILL.md",
      "docs/board.md",
    ]) {
      expect(paths).toContain(path);
    }
  });
});
