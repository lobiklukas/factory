/**
 * At boot, say which trigger rules name a repo with no local checkout (LOB-263).
 *
 * A rule starts a session on its repo, and a repo with no registered `local_path` opens that session
 * in an empty directory: no worktree is cut, so the run produces no diff and its `non_empty_diff`
 * gate or PR step fails columns later. One warning per such rule names the rule's label and its repo
 * — and the command that fixes it — so the operator learns it from the boot log instead of from the
 * first delivery.
 *
 * It reads the `repos` table, the same rule `createBoard` and `workspace.ts` apply, and it reads it
 * after the migrations: those run in a fork beside the server (`applyMigrations`), so the first read
 * can find no table. It is retried a bounded number of times, then gives up with one line saying the
 * check did not run — a database that is down is `/readyz`'s to report, not this log's.
 */
import { noCheckoutWarning } from "@repo/core";
import type { TriggerRule } from "@repo/domain/Trigger";
import { Effect, Layer, Schedule } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/** How often, and how many times, the check re-reads while the migrations are still running. */
const RETRY_EVERY_MS = 1_000;
const RETRY_TIMES = 60;

/** The rules whose repo is not among the repos that hold a `local_path`, in the rules' own order. */
export const rulesWithoutCheckout = (
  rules: ReadonlyArray<TriggerRule>,
  checkedOut: ReadonlySet<string>,
): ReadonlyArray<TriggerRule> =>
  rules.filter((rule) => !checkedOut.has(rule.repo));

/** One warning line: the rule's label, its repo, and what to run. */
export const ruleCheckoutWarning = (rule: TriggerRule): string =>
  `trigger rule "${rule.label}" names ${rule.repo}: ${noCheckoutWarning(rule.repo)}`;

/**
 * Warn once per rule without a checkout. The fork keeps a slow or failing read off the boot path:
 * the server binds first either way.
 */
export const TriggerCheckoutLog = (rules: ReadonlyArray<TriggerRule>) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      if (rules.length === 0) return;
      const sql = yield* SqlClient;
      const check = Effect.gen(function* () {
        const rows = yield* sql<{ slug: string }>`
          SELECT slug FROM repos
          WHERE slug IN ${sql.in(rules.map((rule) => rule.repo))}
            AND local_path IS NOT NULL
        `;
        const missing = rulesWithoutCheckout(
          rules,
          new Set(rows.map((row) => row.slug)),
        );
        for (const rule of missing) {
          yield* Effect.logWarning(ruleCheckoutWarning(rule));
        }
        if (missing.length === 0) {
          yield* Effect.logInfo(
            `trigger rules: every rule's repo has a local checkout (${rules.length})`,
          );
        }
      }).pipe(
        Effect.retry({
          schedule: Schedule.spaced(`${RETRY_EVERY_MS} millis`),
          times: RETRY_TIMES,
        }),
        Effect.catch((error) =>
          Effect.logWarning(
            `trigger rules: could not check which repos have a local checkout: ${error.message}`,
          ),
        ),
      );
      yield* Effect.forkScoped(check);
    }),
  );
