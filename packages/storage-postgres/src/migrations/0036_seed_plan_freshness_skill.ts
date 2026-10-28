import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * The `plan-freshness` skill: the instructions a plan-freshness pass holds (LOB-45).
 *
 * Seeded rather than authored, as 0022 seeds `decompose`, because the rules of a pass are the
 * contract's: `@repo/domain/PlanFreshness` refuses an answer that breaks them, and the prompt says the
 * same rules so a model is told what it will be held to. The pass reads this row by name
 * (`PLAN_FRESHNESS_SKILL` in `packages/harness/src/planFreshness.ts`) every time it runs, so an
 * operator's edit of the body reaches the next pass without a deploy. No column declares it.
 *
 * **A new row, never an update.** `ON CONFLICT (name) DO NOTHING`, so a second pass over a database
 * that already holds the row — or an operator's edited row — changes nothing.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`
    INSERT INTO skills (name, version, description, body, attachments)
    VALUES (
      'plan-freshness',
      '1',
      'Read a plan again after work merged: propose issues to add, re-scope or close against the spec. A person approves each one.',
      ${"# Plan freshness\n\nWork just merged. You compare the goal of record — the spec: its goal and acceptance criteria — with the tracker's current issues for it, and say what the plan is missing. You propose; you change nothing and start nothing. A person reads every proposal before anything happens.\n\nThree kinds of proposal:\n\n- `add`: work the spec asks for that no issue covers. A title no issue has, the goal, the change, and at least one acceptance line naming an observable result.\n- `rescope`: an open issue whose scope no longer matches the spec. Name it by its identifier and give its revised title, goal, change and acceptance lines.\n- `close`: an open issue the spec no longer needs. Name it and say why it is obsolete.\n\nName only issues you were shown, each at most once, and never one that is already closed. Agents overestimate scope: propose the fewest changes that make the plan match the spec, and never work the spec does not ask for. When the plan already matches the spec, answer an empty list.\n"},
      '[]'::jsonb
    )
    ON CONFLICT (name) DO NOTHING
  `;
});
