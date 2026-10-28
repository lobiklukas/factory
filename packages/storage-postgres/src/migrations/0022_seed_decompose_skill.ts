import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * The `decompose` skill: the instructions a decomposition call holds (LOB-201, part 1 of LOB-43).
 *
 * Seeded rather than authored, as 0015 seeds `docs`, because the rules of a decomposition are the
 * contract's, not an operator's choice: `@repo/domain/Decomposition` refuses a set that breaks them,
 * and the prompt says the same rules so a model is told what it will be held to. `proposeDecomposition`
 * reads this row by name (`DECOMPOSITION_SKILL` in `packages/harness/src/decompose.ts`) every time it
 * runs, so an operator's edit of the body reaches the next decomposition without a deploy. No column
 * declares it, so no run's prompt changes.
 *
 * **A new row, never an update.** The insert runs only when no row has the name (`WHERE NOT EXISTS`;
 * it was `ON CONFLICT (name)` until 0037 keyed skills by name and version), so a second pass over a
 * database that already holds the row — or an operator's newer version — changes nothing.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`
    INSERT INTO skills (name, version, description, body, attachments)
    SELECT
      'decompose',
      1,
      'Decompose a spec into proposed child issues: each a title, goal, change and acceptance lines, ordered only where the order is real.',
      ${"# Decompose\n\nYou decompose one engineering spec into the child issues a person will review before any of them exists. You propose; you create nothing and start nothing.\n\nEach proposal is one piece of work a single session can finish: a title no other proposal has, the goal it serves, the change it makes, and at least one acceptance line naming an observable result at its own surface.\n\nPropose fewer, larger pieces rather than many small ones — agents overestimate scope, and the person reviewing cuts. Never propose work the spec does not ask for.\n\n`blockedBy` names another proposal by its index, and only when that proposal must land first. An order you cannot justify is not an order: leave it out. Edges never form a cycle.\n"},
      '[]'::jsonb
    WHERE NOT EXISTS (SELECT 1 FROM skills WHERE name = 'decompose')
  `;
});
