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
 * error, so no gate, no log line and no reader of the payload noticed it. (`docs/next-agent.md` did name
 * `issueId`, but it is the handoff brief, not what a worker reads.) The call sites now spell the
 * argument out; this file is what keeps them.
 *
 * A "call site" is a line that names the tool and carries a `{`, in either of the two shapes below:
 * the ordinary one, where the argument object opens on the same line, and a call a line wrapper broke
 * in two. Prose that names the tool without a brace is exempt, which is deliberate — the explanation
 * beside the fix has to be able to name the wrong argument in order to warn about it. The rule is
 * therefore broader than the bug: a brace-bearing line that documents the *update* form
 * (`save_comment({ id })` edits an existing comment) and a line that names the tool beside its result
 * shape would both redden, and neither is in the corpus today — the update form is documented without
 * a brace, and the result shape sits on a line of its own. Both are accepted rather than papered
 * over, because narrowing the rule to the tool immediately followed by `(` would drop
 * `docs/next-agent.md`'s JSON shape, which is a real instruction.
 *
 * What this can prove: that our instructions hand the agent the argument the server needs, and that
 * they still do after the next edit to a prompt. What it cannot prove: that the hosted server accepts
 * the call. Only a real call does that, and no test may make one (`docs/testing-third-parties.md`).
 * The live half was run by hand on 2026-10-06 and recorded under `.verify/evidence/lob-118/`.
 *
 * The file lives in `@repo/storage-postgres` for the same reason `turbo-env.test.ts`,
 * `postgres-up.test.ts` and `ralph-docker-env.test.ts` do: it is a repo-level claim that belongs to no
 * package, and it needs no database and no container to run. It reads every Markdown file under
 * `.pi/` and `docs/`, plus the root `AGENTS.md` — the trees that instruct an agent. The root
 * `README.md` is the one instruction file outside them, and it names no `save_comment` call.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * The trees that instruct an agent, walked in full. `.ralph/` is deliberately *not* here: it is
 * gitignored run state (`.gitignore`), not an instruction — `.ralph/plan.md`'s LOB-118 row quotes the
 * failing call as part of the bug report. That row would not false-red either: it names `issueId`
 * elsewhere on the same line (in `list_comments({ issueId })`), so the line-based rule below reads it
 * as a call site and then accepts it. Which is a limit of the rule, not a reason for the exclusion.
 */
const CORPUS_DIRS = [".pi", "docs"];

/** The instruction file that sits outside both trees. */
const CORPUS_FILES = ["AGENTS.md"];

const _TOOL = "save_comment";

/** The argument the server needs to create a comment; `id` would update an existing one instead. */
const CREATE_ARGUMENT = "issueId";

/**
 * How many lines before one a call's argument object can sit. One is the wrap a line wrapper produces;
 * two is the furthest a prompt is likely to stretch. Wider than that and the rule starts reading an
 * unrelated `{` on a nearby line as the call's own.
 */
const WRAP_WINDOW = 2;

/** A line that opens a call and closes nothing, so its argument object sits on a later line. */
const OPENS_CALL = /(?:`save_comment`|save_comment)\s*\(?\s*$/;

interface Source {
  readonly path: string;
  readonly text: string;
}

/**
 * A call site detection result with context needed for argument extraction.
 */
interface CallSite {
  readonly lineNumber: number;
  readonly lineText: string;
  readonly isWrapped: boolean;
  readonly openerLineNumber: number | null;
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
const _isCallSite = (line: string, before: readonly string[]): boolean => {
  // Same-line call: tool name followed by ( then { before )
  const sameLinePattern = /(?:`save_comment`|save_comment)\s*\([^)]*\{/;
  if (sameLinePattern.test(line)) return true;

  // Wrapped call: previous line opens the call, this line has {
  if (line.includes("{") && before.some((l) => OPENS_CALL.test(l))) return true;

  return false;
};

/**
 * A source's call sites with context, in file order.
 */
function scan(source: Source): CallSite[] {
  const lines = source.text.split("\n");
  const out: CallSite[] = [];
  lines.forEach((line, index) => {
    const before = lines.slice(Math.max(0, index - WRAP_WINDOW), index);

    // Check for wrapped call first
    const openerIdx = before.findIndex((l) => OPENS_CALL.test(l));
    if (openerIdx >= 0 && line.includes("{")) {
      out.push({
        lineNumber: index + 1,
        lineText: line.trim(),
        isWrapped: true,
        openerLineNumber: index - before.length + openerIdx + 1,
      });
      return;
    }

    // Check for same-line call
    const sameLinePattern = /(?:`save_comment`|save_comment)\s*\([^)]*\{/;
    if (sameLinePattern.test(line)) {
      out.push({
        lineNumber: index + 1,
        lineText: line.trim(),
        isWrapped: false,
        openerLineNumber: null,
      });
    }
  });
  return out;
}

/**
 * The text of a source's call sites, without their line numbers.
 */
const callSites = (source: Source): string[] =>
  scan(source).map((cs) => cs.lineText);

/**
 * Extract the argument object from a save_comment call site using full source context.
 */
function extractArgumentObject(
  source: Source,
  callSite: CallSite,
): string | null {
  const lines = source.text.split("\n");

  if (callSite.isWrapped && callSite.openerLineNumber !== null) {
    // For wrapped calls, the argument object starts on the call site line
    // Find the first { on or after the call site line
    for (let i = callSite.lineNumber - 1; i < lines.length; i++) {
      const line = lines[i]!;
      const bracePos = line.indexOf("{");
      if (bracePos >= 0) {
        // Found the opening brace, now extract the full object
        let depth = 0;
        let inString = false;
        let stringChar = "";
        let foundStart = false;

        for (let li = i; li < lines.length; li++) {
          const currentLine = li === i ? line.slice(bracePos) : lines[li]!;
          for (let ci = 0; ci < currentLine.length; ci++) {
            const ch = currentLine[ci]!;
            const prev =
              ci > 0
                ? currentLine[ci - 1]!
                : li > i
                  ? lines[li - 1]!.slice(-1)
                  : (lines[li - 1]?.[bracePos - 1] ?? "");

            if (!inString && (ch === '"' || ch === "'" || ch === "`")) {
              inString = true;
              stringChar = ch;
            } else if (inString && ch === stringChar && prev !== "\\") {
              inString = false;
            } else if (!inString) {
              if (ch === "{") {
                if (!foundStart) foundStart = true;
                depth++;
              } else if (ch === "}") {
                depth--;
                if (depth === 0 && foundStart) {
                  // Build the full argument object text
                  const endLine = li;
                  const endCol = ci;
                  if (i === endLine) {
                    return lines[i]!.slice(bracePos, endCol + 1);
                  } else {
                    const parts = [lines[i]!.slice(bracePos)];
                    for (let l = i + 1; l < endLine; l++) {
                      parts.push(lines[l]!);
                    }
                    parts.push(lines[endLine]!.slice(0, endCol + 1));
                    return parts.join("\n");
                  }
                }
              }
            }
          }
        }
      }
    }
    return null;
  } else {
    // Same-line call: extract from the call site line
    const line = lines[callSite.lineNumber - 1]!;
    const toolPattern = /(?:`save_comment`|save_comment)\s*\(/;
    const match = line.match(toolPattern);
    if (!match) return null;

    let start = match.index! + match[0].length - 1; // position of '('
    let depth = 0;
    let inString = false;
    let stringChar = "";
    let foundStart = false;

    for (let i = start; i < line.length; i++) {
      const ch = line[i]!;
      const prev = line[i - 1]!;

      if (!inString && (ch === '"' || ch === "'" || ch === "`")) {
        inString = true;
        stringChar = ch;
      } else if (inString && ch === stringChar && prev !== "\\") {
        inString = false;
      } else if (!inString) {
        if (ch === "{") {
          if (!foundStart) foundStart = true;
          depth++;
        } else if (ch === "}") {
          depth--;
          if (depth === 0 && foundStart) {
            return line.slice(start, i + 1);
          }
        }
      }
    }
    return null;
  }
}

/**
 * Check if a call site's argument object contains the required create argument (issueId).
 */
function hasCreateArgument(source: Source, callSite: CallSite): boolean {
  const argObj = extractArgumentObject(source, callSite);
  if (!argObj) return false;
  // Check if issueId appears as a property key in the argument object
  // Match issueId: or issueId= or issueId, or issueId}
  return /\bissueId\s*[:=,]|\bissueId\s*[}\]],?/.test(argObj);
}

/**
 * Every call site that does not name `issueId` in its argument object, as `<path>:<line>: <text>`.
 * An empty list is the contract: the instructions never show the call that fails.
 */
function findings(sources: readonly Source[]): string[] {
  const out: string[] = [];
  for (const source of sources) {
    for (const callSite of scan(source)) {
      if (hasCreateArgument(source, callSite)) continue;
      out.push(`${source.path}:${callSite.lineNumber}: ${callSite.lineText}`);
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
 * carries `save_comment` on its Linear MCP row and no `{` at all, so it is not a call site — and
 * whether a future reword makes it one is an accident of that row's wording, which is not something a
 * tripwire should encode. Case 1 still scans it; this map only pins the files that call the tool on
 * purpose.
 */
const CALLING_FILES: Record<string, number> = {
  ".pi/ralph/close.prompt.md": 1,
  ".pi/ralph/plan.prompt.md": 1,
  ".pi/ralph/split.prompt.md": 1,
  ".pi/ralph/ticket.md": 1,
  ".pi/ralph/work.prompt.md": 4,
};

/**
 * What the map above must add up to, as a literal. Without it, emptying the map would make the loop
 * in the case below vacuous — the same hole a literal `CALLING_FILES` array had before it.
 */
const TOTAL_CALL_SITES = 8;

describe("the loop's save_comment call sites", () => {
  it("names issueId at every call site in the instructions", () => {
    // Mutation checked: deleting `issueId` from any call site in the corpus (the case below does it to
    // `work.prompt.md`) reddens this one and names the file and line.
    expect(findings(corpus())).toEqual([]);
  });

  it("reads a corpus that still holds every call site", () => {
    // Mutation checked: dropping one call site from a file that has several — the partial regression a
    // set of files cannot see — or emptying a corpus directory, or emptying `CALLING_FILES` itself.
    // This is the reason the case above cannot pass by finding nothing, and the reason a file that
    // keeps three of its four call sites still reddens.
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

  it("reddens when a real prompt's call sites lose the argument", () => {
    // Mutation checked: `save_comment({ issueId, body })` -> `save_comment({ id, body })` at every
    // call site of the file the worker reads. The mutation is synthetic — the pre-fix prompt named no
    // argument object at all, which only the count case above can see — and it is the reason the first
    // case is not a tautology.
    const file = ".pi/ralph/work.prompt.md";
    const text = readFileSync(path.join(REPO_ROOT, file), "utf8");
    const mutated = text.replaceAll(CREATE_ARGUMENT, "id");
    expect(mutated).not.toBe(text);
    const found = findings([{ path: file, text: mutated }]);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((line) => line.startsWith(`${file}:`))).toBe(true);
  });

  it("reddens on the exact call that failed, and passes the one that works", () => {
    // Mutation checked: making the checker accept a call site that names `id` instead of `issueId`.
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

  it("exempts prose that names the tool without showing its arguments", () => {
    // Mutation checked: dropping the `{` from `isCallSite`, which would exempt every real call site.
    const prose: Source = {
      path: "synthetic.md",
      text: "`save_comment`'s `id` updates an existing comment, so always pass the issue's identifier.",
    };
    expect(callSites(prose)).toEqual([]);
    expect(findings([prose])).toEqual([]);
  });

  it("reddens on a wrapped call whose argument object is on the next line", () => {
    // Mutation checked: dropping the second disjunct of `isCallSite` — the wrapped-call rule — which
    // exempts a real call a line wrapper broke in two. The first draft of this file missed this:
    // `save_comment(` on one line and `{ id, body }` on the next read as prose, so a prompt could show
    // the failing call and stay green.
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

  it("does not read a result shape as a wrapped call", () => {
    // Mutation checked: loosening the wrapped-call rule from "the previous line opens the call" to
    // "the previous line mentions the tool". `.pi/ralph/work.prompt.md:17` is exactly that near miss —
    // a `{` on the line after a `save_comment` mention, and it is the tool's *result* shape. A rule
    // that flags it false-reds on the prompt this guard exists to protect.
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

  it("catches the wrong call in every shape markdown writes it in", () => {
    // Mutation checked: making the argument test a whole-line `includes` that an unrelated `issueId`
    // anywhere on the line satisfies. Markdown gives a wrong call several places to hide — an HTML
    // comment, a table cell, a fenced block, a space before the paren — and each is still the call
    // that 400s.
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

  it("scans the trees that instruct an agent, not only the files that must carry a call site", () => {
    // Mutation checked: pointing `CORPUS_DIRS` at the calling files only, or dropping a tree from it,
    // which would make the first case a check of a hand-picked list rather than of every tree that
    // instructs an agent.
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

  it("reddens on a backtick-wrapped call whose argument object is on the next line", () => {
    // Mutation checked: widening `OPENS_CALL` to accept a backtick-wrapped opener without the paren
    // (`\`save_comment\`` instead of `\`save_comment\`(`) makes this case go green when it should red.
    const wrong: Source = {
      path: "synthetic.md",
      text: '`save_comment`\n  ({ id: "LOB-118", body: "hi" })\n',
    };
    expect(findings([wrong])).toEqual([
      'synthetic.md:2: ({ id: "LOB-118", body: "hi" })',
    ]);

    const right: Source = {
      path: "synthetic.md",
      text: '`save_comment`\n  ({ issueId: "LOB-118", body: "hi" })\n',
    };
    expect(findings([right])).toEqual([]);
  });

  it("catches a wrong call even when issueId appears elsewhere on the line", () => {
    // Mutation checked: changing `hasCreateArgument` back to a whole-line `includes(CREATE_ARGUMENT)`
    // instead of parsing the argument object makes the masked call pass when it should red.
    const wrong: Source = {
      path: "synthetic.md",
      text: "save_comment({ id, body })  // nearby: list_comments({ issueId })",
    };
    expect(findings([wrong])).toEqual([
      "synthetic.md:1: save_comment({ id, body })  // nearby: list_comments({ issueId })",
    ]);

    const right: Source = {
      path: "synthetic.md",
      text: "save_comment({ issueId, body })  // nearby: list_comments({ issueId })",
    };
    expect(findings([right])).toEqual([]);
  });

  it("leaves no case unaccounted for in the mutation note every case carries", () => {
    // Mutation checked: deleting every `Mutation checked:` line a case carries, whose case then
    // appears in `unaccounted` — this case included, since its own note is the only place the marker
    // is written inside it.
    const MUTATION_NOTE = "Mutation checked:";
    const isMutationNote = (line: string): boolean =>
      /^\s*\/\//.test(line) && line.includes(MUTATION_NOTE);

    const lines = readFileSync(fileURLToPath(import.meta.url), "utf8").split(
      "\n",
    );
    // Count test declarations: it(, it.each(, it.skip(, test(
    const declarations = lines.flatMap((line, index) =>
      /^\s*(?:it|test)(?:\.[\w$]+(?:\([^)]*\))?)*\(/.test(line) ? [index] : [],
    );
    // The count is a tripwire: bump when a case is added, and give the new case its note.
    expect(
      declarations,
      "declaration count changed — bump the count and keep every case's mutation note",
    ).toHaveLength(12);
    const unaccounted = declarations.filter((start, position) => {
      const end = declarations[position + 1] ?? lines.length;
      return !lines.slice(start, end).some(isMutationNote);
    });
    expect(unaccounted.map((index) => lines[index]?.trim())).toEqual([]);
  });
});
