import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The cases that talk to a real Postgres or spawn a `bash` declare their own budget, so none of
 * them runs at vitest's 5 s default (LOB-136).
 *
 * The default is a wall-clock budget, and a case like that inherits whatever load the rest of the
 * package is putting on the machine. Measured across four `bunx turbo run test --force` runs of the
 * whole gate (`02-baseline-full-gate-verbose.log`, `02-`, `03-` and `04-full-gate-verbose.log` in
 * `.verify/evidence/lob-136/`), the two slowest cases in the guarded files reached 4 741 ms
 * (`ralph-opencode.test.ts`, which sources the driver and runs a shim through it) and 4 231 ms
 * (`PostgresStorage.test.ts`'s fat-log paging case, which seeds 2 001 commits one at a time) — both
 * inside the 5 000 ms default, which is the red this issue was filed for. Which case lands on top
 * moves from run to run, which is the signature of load rather than of one slow case. `30_000` is
 * the budget this package already uses (LOB-128 on `ralph-docker-env.test.ts`, LOB-132 on
 * `postgres-up.test.ts`, LOB-108 on `ralph-ensure-db.test.ts`), which leaves ~6x over the worst
 * measurement; it is a convention adopted, not one derived.
 *
 * `GUARDED` is not every test file in the package, and `NOT_GUARDED` is the reason for each one
 * that is not. Three read a file and assert on its text — no database, no subprocess — and their
 * *worst* case across those same four runs was 16 ms (`mcp-pin.test.ts`), 764 ms
 * (`ralph-linear-calls.test.ts`) and 791 ms (`ralph-settled-decisions.test.ts`); a fourth,
 * `ralph-ensure-db.test.ts`'s single unbudgeted case, reads the driver's body and peaked at 11 ms.
 * None is exposed to the load that made this issue red, which is the measured reason to leave them
 * alone rather than a claim that they are safe forever. **LOB-137** is the ticket for the rest of
 * the package, and a file that grows a database or a `bash` call is the moment its budget stops
 * being optional. The two lists must together name every suite file under this package, so a new
 * one cannot land unchecked.
 *
 * The guard reads the files back rather than trusting the diff, because the failure it prevents is
 * a *future* edit that adds a case and forgets its budget. It is a source scan, so it can only say
 * that a declaration does not name a budget — not that the case is fast. The measurement above is
 * the other half of the claim, and it is in this header so it can be rechecked.
 *
 * The scan is the same line-and-span loop `postgres-up.test.ts:1438-1460` and
 * `ralph-docker-env.test.ts:859-877` already use, and it inherits their blind spots rather than
 * inventing a parser to avoid them: it reads a `timeout:` from anywhere in a declaration's span, so
 * a `timeout` belonging to something *inside* a case body would pass as that case's budget (no such
 * line exists in the guarded files today, and `grep -n timeout` over both returns only the budgets
 * themselves); and it cannot see a declaration whose table is a tagged template
 * (`it.each\`…\`(…)`), which is the blind spot **LOB-119** was filed for on the sibling guard. Two
 * things here are deliberately stricter than the siblings: the budget must *exceed* the 5 000 ms
 * default it exists to beat, and the scan reaches every suite file in the package rather than one.
 */

/** The budget a case must beat to count: vitest's default, which is what this issue is about. */
const DEFAULT_MS = 5_000;

/** Files whose every case is checked, relative to this file's directory. */
const GUARDED = [
  "PostgresStorage.test.ts",
  "ralph-opencode.test.ts",
  "case-budgets.test.ts",
] as const;

/**
 * Files deliberately not checked, each with why. Adding a name here is a claim a reviewer can
 * falsify against the measurement in the header; adding nothing while adding a new suite file is not
 * possible, which is the point of the case that reads the two lists against the directory.
 */
const NOT_GUARDED: Readonly<Record<string, string>> = {
  "mcp-pin.test.ts":
    "reads .mcp.json and docs, asserts on text; no database, no subprocess; 16 ms worst of four gate runs",
  "postgres-up.test.ts":
    "budgeted case by case (LOB-132) and carries its own read-back guard; 29 declarations",
  "ralph-docker-env.test.ts":
    "budgeted case by case (LOB-128) and carries its own read-back guard; 16 declarations",
  "ralph-ensure-db.test.ts":
    "7 of 8 budgeted; the 8th reads the driver's body and asserts on text; 11 ms worst of four gate runs",
  "ralph-linear-calls.test.ts":
    "reads the instruction files, asserts on text; no database, no subprocess; 764 ms worst of four gate runs",
  "ralph-settled-decisions.test.ts":
    "reads docs/design.md and the instruction files, asserts on text; no database, no subprocess; 791 ms worst of four gate runs",
  "turbo-env.test.ts":
    "every case already budgets itself with a trailing `, 90_000)` or `, 120_000)` (LOB-92); 4 declarations",
};

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** A file vitest collects as a suite, in either spelling and at any depth below a package. */
const SUITE_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** Every suite file under `dir`, at any depth, named relative to `dir` itself. */
const suiteFilesIn = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return suiteFilesIn(full).map((nested) => path.join(entry.name, nested));
    }
    return SUITE_FILE.test(entry.name) ? [entry.name] : [];
  });

/** A declaration: `it`/`test`, any `.each`/`.skip`/`.concurrent` chain, then its argument list. */
const DECLARATION = /^\s*(?:it|test)(?:\.[\w$]+(?:\([^)]*\))?)*\(/;

/** The digits of a budget written as `N`, `N_000` or `30_000`, if the text is one. */
const budgetIn = (text: string): number | undefined => {
  const digits = text.replace(/_/g, "");
  return /^\d+$/.test(digits) ? Number(digits) : undefined;
};

/**
 * Whether a declaration's span names a budget that beats vitest's default.
 *
 * Both shapes vitest accepts count — `{ timeout: 30_000 }` as the second argument, and a trailing
 * `, 30_000)` — and a value at or below `DEFAULT_MS` does not, because `{ timeout: 5_000 }` is the
 * default restated and `{ timeout: 0 }` is no timeout at all. Both would leave this issue's own
 * failure in place while the guard read green.
 */
const declaresABudget = (span: readonly string[]): boolean =>
  span.some((line) => {
    const option = /\btimeout\s*:\s*(\d[\d_]*)/.exec(line);
    if (option !== null) return (budgetIn(option[1] ?? "") ?? 0) > DEFAULT_MS;
    const trailing = /,\s*(\d[\d_]*)\s*\)\s*;?\s*$/.exec(line);
    return trailing !== null && (budgetIn(trailing[1] ?? "") ?? 0) > DEFAULT_MS;
  });

/** The declarations in `source` that name no budget, as `line: text` strings. */
const unbudgetedIn = (source: string): string[] => {
  const lines = source.split("\n");
  const declarations = lines.flatMap((line, index) =>
    DECLARATION.test(line) ? [index] : [],
  );
  return declarations
    .flatMap((start, position) => {
      const end = declarations[position + 1] ?? lines.length;
      return declaresABudget(lines.slice(start, end)) ? [] : [start];
    })
    .map(
      (start) => `line ${String(start + 1)}: ${(lines[start] ?? "").trim()}`,
    );
};

describe("the storage suite's case budgets", () => {
  // Mutation: delete `{ timeout: 30_000 },` from any case in any guarded file — the case below
  // reddens, naming the line that lost its budget. Mutation: scan only the last declaration of a
  // file — a budget dropped from any earlier case goes unseen, and this reddens instead.
  it(
    "gives every case in the database-bound and process-bound files a budget",
    { timeout: 30_000 },
    () => {
      const missing = GUARDED.flatMap((file) =>
        unbudgetedIn(readFileSync(path.join(HERE, file), "utf8")),
      );
      expect(missing).toEqual([]);
    },
  );

  // Mutation: drop a file from `GUARDED` without adding it to `NOT_GUARDED` — this reddens naming the
  // file that is on neither list. Mutation: add a suite file and put it on neither list — this
  // reddens naming the new file. Mutation: put a guarded file on both lists — this reddens on the
  // second assertion, because a file on both would be checked while claiming not to be.
  it(
    "puts every suite file in the package on exactly one of the two lists",
    { timeout: 30_000 },
    () => {
      expect([...GUARDED, ...Object.keys(NOT_GUARDED)].sort()).toEqual(
        suiteFilesIn(HERE).sort(),
      );
      const overlap = [...GUARDED].filter((file) => file in NOT_GUARDED);
      expect(overlap).toEqual([]);
    },
  );

  // Mutation: stop descending into subdirectories, or match only `*.test.ts` — the nested `.spec`
  // file below stops being listed and this reddens. The package has no nested suite file today, so
  // the partition case above cannot tell a recursive listing from a flat one; this one can.
  it(
    "reaches a suite file at any depth, in either spelling",
    { timeout: 30_000 },
    () => {
      const root = mkdtempSync(path.join(tmpdir(), "factory-case-budgets-"));
      try {
        mkdirSync(path.join(root, "nested/deeper"), { recursive: true });
        for (const name of [
          "top.test.ts",
          "top.spec.ts",
          "not-a-suite.ts",
          "nested/mid.test.ts",
          "nested/deeper/low.spec.ts",
          "nested/README.md",
        ]) {
          writeFileSync(path.join(root, name), "");
        }
        expect(suiteFilesIn(root).sort()).toEqual([
          "nested/deeper/low.spec.ts",
          "nested/mid.test.ts",
          "top.spec.ts",
          "top.test.ts",
        ]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  // Mutation: change `DEFAULT_MS` to `0`, or drop the `>` — `{ timeout: 5_000 }` and
  // `{ timeout: 0 }` start counting and this reddens. That edit is the one that would leave this
  // issue's flake in place behind a green guard, which is why the floor is a case and not a comment.
  it(
    "counts only a budget that beats vitest's 5 s default",
    { timeout: 30_000 },
    () => {
      const shapes = [
        'it("options object", { timeout: 30_000 }, async () => {});',
        'it("trailing number", async () => {}, 30_000);',
        'it("underscored", { timeout: 120_000 }, async () => {});',
        'it("the default restated", { timeout: 5_000 }, async () => {});',
        'it("no timeout at all", { timeout: 0 }, async () => {});',
        'it("neither", async () => {});',
      ].join("\n");
      expect(unbudgetedIn(shapes)).toEqual([
        'line 4: it("the default restated", { timeout: 5_000 }, async () => {});',
        'line 5: it("no timeout at all", { timeout: 0 }, async () => {});',
        'line 6: it("neither", async () => {});',
      ]);
    },
  );

  // Mutation: narrow `DECLARATION` to a bare `it(` — the `it.each(TABLE)(` form below stops being
  // found and this reddens. That shape is the one this package actually uses (five of them in
  // `postgres-up.test.ts`), which is why the chain is matched rather than assumed.
  it("finds a declaration behind a modifier chain", { timeout: 30_000 }, () => {
    const chained = [
      'it.each(UP_SCRIPTS)("budgeted", { timeout: 30_000 }, async () => {});',
      'it.each(UP_SCRIPTS)("unbudgeted", async () => {});',
      'it.skip("skipped and unbudgeted", async () => {});',
    ].join("\n");
    expect(unbudgetedIn(chained)).toEqual([
      'line 2: it.each(UP_SCRIPTS)("unbudgeted", async () => {});',
      'line 3: it.skip("skipped and unbudgeted", async () => {});',
    ]);
  });

  // Mutation: match `describe`/`beforeAll`/`afterAll` too — the three hooks below stop being ignored
  // and this reddens on the extra findings. `PostgresStorage.test.ts` declares both, so a scan that
  // counted them would report budgets, or missing ones, that mean nothing.
  it("reads no hook or suite as a case", { timeout: 30_000 }, () => {
    const hooks = [
      'describe("a suite", () => {',
      "  beforeAll(async () => {}, 60_000);",
      "  afterAll(async () => { await runtime.dispose(); });",
      "  beforeEach(() => {});",
      '  it("the only case", { timeout: 30_000 }, async () => {});',
      "});",
    ].join("\n");
    expect(unbudgetedIn(hooks)).toEqual([]);
    expect(
      hooks.split("\n").filter((line) => DECLARATION.test(line)),
    ).toHaveLength(1);
  });
});
