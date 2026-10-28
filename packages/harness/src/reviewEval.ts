/**
 * Scoring the reviewer against the corpus (LOB-242): what a run left on the forge, read back as the
 * columns of an evidence table.
 *
 * The gate proves the reviewer's structure with the faux provider (`review.test.ts`): the rubric, the
 * file check, one comment per head. It cannot prove that a real model finds a real bug and stays quiet
 * on a clean change. `bun run review-eval` is the opt-in measurement of that, and this module is its
 * pure half — the reading of a posted comment, the five columns, the threshold, the table — so the
 * half that never touches a model or a database is under test in the gate.
 *
 * The columns, per pull request:
 *   - **reviewed**: the run's `review` call was accepted, so the model gave a verdict at all.
 *   - **posted**: the comment reached the forge. A review with no finding is `clean` and posts
 *     nothing (`reviewTool`), so a seeded PR that is not posted is a miss, and a clean PR that is
 *     not posted is the right answer.
 *   - **detected** (seeded): the posted review fails — it holds a P0 or P1 finding.
 *   - **named the file** (seeded): a blocking finding names the seeded file.
 *   - **named the mechanism** (seeded): a blocking finding on that file says what is wrong, in words
 *     the corpus entry lists. Nested on purpose: each column implies the one before it, so a rate is
 *     never higher than the rate to its left.
 *   - **false positive** (clean): the posted review fails. A P2 on a clean change is a nit and does
 *     not count, which is the rubric's own line between blocking and not.
 *   - **other blocking**: blocking findings that are not the seeded bug, on either kind of entry.
 */
import { Effect } from "effect";
import type { ReviewEvalEntry } from "./reviewEvalCorpus";
import {
  checkFindingFiles,
  decodeReview,
  isBlocking,
  renderReview,
  reviewFindings,
  type Review,
  type ReviewDimension,
  type ReviewTarget,
  type Severity,
} from "./review";

export type ParsedFinding = {
  readonly severity: Severity;
  readonly dimension: string;
  readonly file: string;
  readonly line: number | undefined;
  readonly mechanism: string;
};

export type ParsedComment = {
  readonly verdict: "pass" | "fail";
  readonly findings: readonly ParsedFinding[];
};

const BULLET = /^- \*\*(P[012])\*\* · (\w+) · `([^`]+)` — (.*)$/;
const LOCATION = /^(.*?)(?::(\d+))?$/;

/**
 * A posted review comment (`renderReview`'s format) read back into its verdict and findings, or
 * `undefined` for a body that is not one. Read from the comment rather than the tool call because the
 * comment is what the forge holds: if the rendering and this reading ever disagree the unit suite
 * fails, instead of the table quietly scoring nothing.
 */
export const parseReviewComment = (body: string): ParsedComment | undefined => {
  const heading =
    /^## Factory review: (changes needed|no blocking finding)$/m.exec(body);
  if (heading === null) return undefined;
  const start = body.indexOf("### Findings");
  const end = body.indexOf("<details>");
  const section = start < 0 ? "" : body.slice(start, end < 0 ? undefined : end);
  const findings: ParsedFinding[] = [];
  for (const line of section.split("\n")) {
    const bullet = BULLET.exec(line);
    if (bullet !== null) {
      const [, severity, dimension, location, mechanism] = bullet;
      const where = LOCATION.exec(location ?? "");
      findings.push({
        severity: severity as Severity,
        dimension: dimension ?? "",
        file: where?.[1] ?? "",
        line: where?.[2] === undefined ? undefined : Number(where[2]),
        mechanism: mechanism ?? "",
      });
    } else if (findings.length > 0 && line.trim() !== "") {
      // A mechanism that runs over lines belongs to the bullet above it.
      const last = findings[findings.length - 1];
      if (last !== undefined) {
        findings[findings.length - 1] = {
          ...last,
          mechanism: `${last.mechanism}\n${line}`,
        };
      }
    }
  }
  return {
    verdict: heading[1] === "changes needed" ? "fail" : "pass",
    findings,
  };
};

/** What a run left behind, as the driver collects it: nothing here is a judgement. */
export type ReviewEvalRecord = {
  readonly id: string;
  readonly sessionId: string | null;
  /** The model the run talked to, `provider/id`. */
  readonly model: string | null;
  /** The run's `review` call was accepted. */
  readonly reviewed: boolean;
  /** The body of the comment the forge was handed, or `null` when it got none. */
  readonly comment: string | null;
  /** US dollars, from the session's own `pi.usage` ledger. */
  readonly cost: number;
  /** Why a run that was not reviewed was not, for a person reading the table. */
  readonly note: string;
};

export type ReviewEvalRow = {
  readonly id: string;
  readonly pr: number;
  readonly title: string;
  readonly kind: "seeded" | "clean";
  readonly bug: string | null;
  readonly reviewed: boolean;
  readonly posted: boolean;
  readonly detected: boolean | null;
  readonly namedFile: boolean | null;
  readonly namedMechanism: boolean | null;
  readonly falsePositive: boolean | null;
  readonly otherBlocking: number;
  readonly cost: number;
  readonly model: string | null;
};

const escaped = (phrase: string): string =>
  phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether `text` says one of `phrases`: case-insensitive, and a phrase has to stand on whole words, so
 * `dead` is not found in `deadline` and `swap` is not found in `swapped` (a seed lists the forms it
 * wants). A phrase that starts or ends with a symbol (`=== 1`) needs no boundary on that side.
 */
export const namesMechanism = (
  text: string,
  phrases: readonly string[],
): boolean =>
  phrases.some((phrase) =>
    new RegExp(
      `${/^\w/.test(phrase) ? "(?<![\\w])" : ""}${escaped(phrase)}${/\w$/.test(phrase) ? "(?![\\w])" : ""}`,
      "i",
    ).test(text),
  );

/** Score one run against its entry. */
export const scoreReviewEval = (
  entry: ReviewEvalEntry,
  record: ReviewEvalRecord,
): ReviewEvalRow => {
  const parsed =
    record.comment === null ? undefined : parseReviewComment(record.comment);
  const blocking = (parsed?.findings ?? []).filter((finding) =>
    isBlocking(finding.severity),
  );
  const failed = parsed?.verdict === "fail" && blocking.length > 0;
  const base = {
    id: entry.id,
    pr: entry.pr,
    title: entry.title,
    reviewed: record.reviewed,
    posted: parsed !== undefined,
    cost: record.cost,
    model: record.model,
  };
  const { seed } = entry;
  if (seed === undefined) {
    return {
      ...base,
      kind: "clean",
      bug: null,
      detected: null,
      namedFile: null,
      namedMechanism: null,
      falsePositive: failed,
      otherBlocking: blocking.length,
    };
  }
  const onFile = blocking.filter((finding) => finding.file === seed.file);
  const namedFile = failed && onFile.length > 0;
  const namedMechanism =
    namedFile &&
    onFile.some((finding) => namesMechanism(finding.mechanism, seed.mechanism));
  return {
    ...base,
    kind: "seeded",
    bug: seed.kind,
    detected: failed,
    namedFile,
    namedMechanism,
    falsePositive: null,
    otherBlocking: blocking.length - onFile.length,
  };
};

/**
 * What the reviewer has to reach before the factory trusts it (LOB-242). Chosen against the cost of
 * each error rather than for a round number:
 *
 * - `reviewed` is 1: a run that gave no verdict is a review the card never gets, and a reviewer that
 *   sometimes says nothing cannot gate `review → done` (`review_verdict`, LOB-241).
 * - `detected` and `namedFile` are 0.8: a miss lets a bug through *to a human who would have read the
 *   diff anyway*, so the reviewer has to be right most of the time, not always. A review that fails
 *   a PR without pointing at the file is not actionable, so it is held to the same line.
 * - `namedMechanism` is 0.6: the mechanism column is matched by phrases, so it is the noisiest, and
 *   it is a quality signal, not a safety one.
 * - `falsePositiveMax` is 0.2: a false alarm costs a builder a pointless round trip and teaches
 *   everyone to ignore the reviewer, which is the failure that makes the whole gate worthless.
 *
 * They are rates over the corpus, so adding pull requests to it keeps them meaningful. On the
 * corpus's six and six: five of six detected, five named, four mechanisms, at most one false alarm.
 */
export const REVIEW_EVAL_THRESHOLD = {
  reviewed: 1,
  detected: 0.8,
  namedFile: 0.8,
  namedMechanism: 0.6,
  falsePositiveMax: 0.2,
} as const;

export type ReviewEvalCheck = {
  readonly name: string;
  /** `>=` or `<=`: which side of `required` passes. */
  readonly op: ">=" | "<=";
  readonly actual: number;
  readonly required: number;
  readonly met: boolean;
  /** `count/of`, for the table. */
  readonly ratio: string;
};

export type ReviewEvalSummary = {
  readonly seeded: number;
  readonly clean: number;
  readonly reviewed: number;
  readonly posted: number;
  readonly detected: number;
  readonly namedFile: number;
  readonly namedMechanism: number;
  readonly falsePositives: number;
  readonly cost: number;
  readonly checks: readonly ReviewEvalCheck[];
  /** Every check is met, over at least the five and five the issue asks for. */
  readonly trusted: boolean;
};

/** The smallest corpus a result means anything on. */
export const REVIEW_EVAL_MIN_PER_KIND = 5;

const count = (
  rows: readonly ReviewEvalRow[],
  pick: (row: ReviewEvalRow) => boolean | null,
) => rows.filter((row) => pick(row) === true).length;

export const summarizeReviewEval = (
  rows: readonly ReviewEvalRow[],
): ReviewEvalSummary => {
  const seeded = rows.filter((row) => row.kind === "seeded");
  const clean = rows.filter((row) => row.kind === "clean");
  const detected = count(seeded, (row) => row.detected);
  const namedFile = count(seeded, (row) => row.namedFile);
  const namedMechanism = count(seeded, (row) => row.namedMechanism);
  const falsePositives = count(clean, (row) => row.falsePositive);
  const reviewed = count(rows, (row) => row.reviewed);
  const rate = (hits: number, of: number) => (of === 0 ? 0 : hits / of);
  const check = (
    name: string,
    op: ">=" | "<=",
    hits: number,
    of: number,
    required: number,
  ): ReviewEvalCheck => {
    const actual = rate(hits, of);
    return {
      name,
      op,
      actual,
      required,
      // Floating point: 4/5 against 0.8 is the case this has to get right.
      met:
        of > 0 &&
        (op === ">=" ? actual >= required - 1e-9 : actual <= required + 1e-9),
      ratio: `${hits}/${of}`,
    };
  };
  const checks = [
    check(
      "reviewed",
      ">=",
      reviewed,
      rows.length,
      REVIEW_EVAL_THRESHOLD.reviewed,
    ),
    check(
      "detected",
      ">=",
      detected,
      seeded.length,
      REVIEW_EVAL_THRESHOLD.detected,
    ),
    check(
      "named the file",
      ">=",
      namedFile,
      seeded.length,
      REVIEW_EVAL_THRESHOLD.namedFile,
    ),
    check(
      "named the mechanism",
      ">=",
      namedMechanism,
      seeded.length,
      REVIEW_EVAL_THRESHOLD.namedMechanism,
    ),
    check(
      "false positives",
      "<=",
      falsePositives,
      clean.length,
      REVIEW_EVAL_THRESHOLD.falsePositiveMax,
    ),
  ];
  return {
    seeded: seeded.length,
    clean: clean.length,
    reviewed,
    posted: count(rows, (row) => row.posted),
    detected,
    namedFile,
    namedMechanism,
    falsePositives,
    cost: rows.reduce((total, row) => total + row.cost, 0),
    checks,
    trusted:
      seeded.length >= REVIEW_EVAL_MIN_PER_KIND &&
      clean.length >= REVIEW_EVAL_MIN_PER_KIND &&
      checks.every((entry) => entry.met),
  };
};

const mark = (value: boolean | null): string =>
  value === null ? "-" : value ? "yes" : "no";

const dollars = (value: number): string => `$${value.toFixed(4)}`;

/** The evidence table: one row per pull request, then the totals and each threshold check. */
export const renderReviewEvalTable = (
  rows: readonly ReviewEvalRow[],
  summary: ReviewEvalSummary,
  meta: { readonly mode: string; readonly models: readonly string[] },
): string => {
  const percent = (value: number) => `${Math.round(value * 100)}%`;
  return [
    "# Reviewer measurement (LOB-242)",
    "",
    `Mode: ${meta.mode}. Model: ${meta.models.length === 0 ? "none recorded" : meta.models.join(", ")}.`,
    "",
    "| PR | Kind | Seeded bug | Reviewed | Posted | Detected | Named the file | Named the mechanism | False positive | Other blocking | Cost |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (row) =>
        `| #${row.pr} ${row.id} | ${row.kind} | ${row.bug ?? "-"} | ${mark(row.reviewed)} | ${mark(row.posted)} | ${mark(row.detected)} | ${mark(row.namedFile)} | ${mark(row.namedMechanism)} | ${mark(row.falsePositive)} | ${row.otherBlocking} | ${dollars(row.cost)} |`,
    ),
    "",
    `Seeded ${summary.seeded}, clean ${summary.clean}. Total cost ${dollars(summary.cost)}.`,
    "",
    "| Threshold | Result | Required | Met |",
    "| --- | --- | --- | --- |",
    ...summary.checks.map(
      (entry) =>
        `| ${entry.name} | ${entry.ratio} (${percent(entry.actual)}) | ${entry.op} ${percent(entry.required)} | ${mark(entry.met)} |`,
    ),
    "",
    summary.trusted
      ? "Verdict: the reviewer meets the threshold."
      : "Verdict: the reviewer does not meet the threshold on this run.",
    "",
  ].join("\n");
};

/** What a faux reviewer does with an entry, so the proof can show a table that tells entries apart. */
export type ReviewEvalFauxBehavior =
  /** Seeded: finds the bug in the right file and says what it is. */
  | "right"
  /** Seeded: reviews, finds nothing. */
  | "miss"
  /** Seeded: fails the right file for a reason that is not the bug. */
  | "wrong-mechanism"
  /** Seeded: fails a different file in the diff. */
  | "wrong-file"
  /** Clean: reviews, finds nothing. */
  | "quiet"
  /** Clean: only a P2 nit, which is not a false positive. */
  | "nit"
  /** Clean: fails a file in the diff for no reason. */
  | "false-positive";

/** The faux reviewer's answers: three misses of three kinds, a nit and a false alarm among twelve. */
export const REVIEW_EVAL_FAUX_BEHAVIOR: Readonly<
  Record<string, ReviewEvalFauxBehavior>
> = {
  "seed-usage-total": "right",
  "seed-send-yield": "right",
  "seed-no-change-count": "miss",
  "seed-outcome-tag": "right",
  "seed-reclaim-compare": "wrong-mechanism",
  "seed-board-repo": "wrong-file",
  "clean-fork-pr-doc": "quiet",
  "clean-lifecycle-action": "nit",
  "clean-docs-write-rule": "quiet",
  "clean-title-entry": "false-positive",
  "clean-dev-env": "quiet",
  "clean-sleeping-faux": "quiet",
};

const passing = {
  verdict: "pass",
  findings: [],
} as const;

/**
 * The `review` arguments a faux reviewer files for an entry (`FAUX_REVIEW`'s one attempt). `changed` is
 * the PR's paths, which `checkFindingFiles` holds a finding to; a behavior that needs a file other
 * than the seeded one and finds none in the diff falls back to the answer that names nothing.
 */
export const fauxReviewFor = (
  entry: ReviewEvalEntry,
  behavior: ReviewEvalFauxBehavior,
  changed: readonly string[],
): Record<string, unknown> => {
  const dimensions = (
    correctness: Review["dimensions"][ReviewDimension],
    tests: Review["dimensions"][ReviewDimension] = passing,
  ) => ({
    correctness,
    security: passing,
    tests,
    performance: passing,
  });
  const fail = (
    severity: Severity,
    file: string,
    mechanism: string,
    line = 1,
  ): Review["dimensions"][ReviewDimension] => ({
    verdict: "fail",
    findings: [{ severity, file, line, mechanism }],
  });
  const seedFile = entry.seed?.file ?? "";
  const other = changed.find((path) => path !== seedFile);
  const summary = `Reviewed ${entry.title}.`;
  const none = { summary, dimensions: dimensions(passing) };
  switch (behavior) {
    case "right":
      return entry.seed === undefined
        ? none
        : {
            summary,
            dimensions: dimensions(fail("P0", entry.seed.file, entry.seed.bug)),
          };
    case "wrong-mechanism":
      return entry.seed === undefined
        ? none
        : {
            summary,
            dimensions: dimensions(
              fail(
                "P1",
                entry.seed.file,
                "The new comment above this block is longer than the code it describes and should be trimmed before merging",
              ),
            ),
          };
    case "wrong-file":
      return other === undefined
        ? none
        : {
            summary,
            dimensions: dimensions(
              fail(
                "P1",
                other,
                "The added test does not cover the empty input and so leaves the helper's edge unpinned",
              ),
            ),
          };
    case "false-positive":
      return other === undefined && changed[0] === undefined
        ? none
        : {
            summary,
            dimensions: dimensions(
              fail(
                "P1",
                other ?? changed[0] ?? "",
                "The added helper name is ambiguous and a caller could mistake it for the older one",
              ),
            ),
          };
    case "nit":
      return changed[0] === undefined
        ? none
        : {
            summary,
            dimensions: dimensions({
              verdict: "pass",
              findings: [
                {
                  severity: "P2",
                  file: changed[0],
                  line: 1,
                  mechanism:
                    "A doc comment here could name the issue it came from",
                },
              ],
            }),
          };
    case "miss":
    case "quiet":
      return none;
  }
};

/**
 * The comment a faux reviewer's answer leaves on the forge, or `null` when it leaves none: the answer
 * goes through the real rubric (`decodeReview`), the real file check against `changed`, and the real
 * rendering, and a review with no finding posts nothing, as `reviewTool` does. What the proof expects
 * the table to say is this, scored — so the expectation and the live path share every step but the
 * model and the transport.
 */
export const fauxPostedComment = (
  entry: ReviewEvalEntry,
  behavior: ReviewEvalFauxBehavior,
  changed: readonly string[],
  target: ReviewTarget,
): string | null => {
  const review = Effect.runSync(
    decodeReview(fauxReviewFor(entry, behavior, changed)).pipe(
      Effect.flatMap((decoded) => checkFindingFiles(decoded, changed)),
    ),
  );
  return reviewFindings(review).length === 0
    ? null
    : renderReview({ review, target, marker: "<!-- faux -->" });
};
