/**
 * The boot warning for trigger rules whose repo has no local checkout (LOB-263), against the real
 * `repos` table: one warning per rule, naming its label and repo, and none for a rule whose repo has
 * a path. Postgres only, as the rest of this app's database cases: `docker compose up -d --wait postgres`.
 */
import { noCheckoutWarning } from "@repo/core";
import { RepoSlug } from "@repo/domain/Session";
import type { TriggerRule } from "@repo/domain/Trigger";
import { DatabaseLive } from "@repo/storage-postgres";
import {
  Deferred,
  Effect,
  Exit,
  Layer,
  Logger,
  ManagedRuntime,
  Scope,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  rulesWithoutCheckout,
  ruleCheckoutWarning,
  TriggerCheckoutLog,
} from "./TriggerCheckouts";

const runtime = ManagedRuntime.make(DatabaseLive);
afterAll(() => runtime.dispose());

const run = randomBytes(4).toString("hex");
const slug = (name: string) => RepoSlug.make(`acme/${name}-${run}`);

const rule = (label: string, repo: RepoSlug): TriggerRule => ({
  label,
  repo,
  prompt: "do the thing",
});

/** Insert or update a registry row, as `registerRepo` and a session's first use write one. */
const setRepo = (repo: RepoSlug, localPath: string | null) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql`
        INSERT INTO repos (slug, url, default_base_ref, local_path)
        VALUES (${repo}, '', 'main', ${localPath})
        ON CONFLICT (slug) DO UPDATE SET local_path = EXCLUDED.local_path
      `;
    }),
  );

/**
 * Boot the log layer over the real table and collect what it logs until `settled` says it is done.
 * The layer forks its read, so the case waits on a `Deferred` the logger completes, not on a sleep.
 */
const bootLog = (
  rules: ReadonlyArray<TriggerRule>,
  settled: (lines: ReadonlyArray<string>) => boolean,
) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const lines: Array<string> = [];
      const done = yield* Deferred.make<void>();
      const logger = Logger.make(({ message, logLevel }) => {
        lines.push(
          `${logLevel}: ${(Array.isArray(message) ? message : [message]).map(String).join(" ")}`,
        );
        if (settled(lines)) Deferred.doneUnsafe(done, Exit.void);
      });
      const scope = yield* Scope.make();
      yield* Layer.buildWithScope(TriggerCheckoutLog(rules), scope).pipe(
        Effect.provide(Logger.layer([logger])),
      );
      yield* Deferred.await(done);
      yield* Scope.close(scope, Exit.void);
      return lines;
    }),
  );

describe("rulesWithoutCheckout", () => {
  /** Mutation: compare labels instead of repos, or keep the rules that are checked out. */
  it("keeps the rules whose repo holds no path, in the rules' order, and the same repo under two labels twice", () => {
    const a = slug("a");
    const b = slug("b");
    const rules = [rule("one", a), rule("two", b), rule("three", a)];
    expect(
      rulesWithoutCheckout(rules, new Set([b])).map((r) => r.label),
    ).toEqual(["one", "three"]);
    expect(rulesWithoutCheckout(rules, new Set([a, b]))).toEqual([]);
  });

  it("names the label, the repo and the command that fixes it", () => {
    const repo = slug("named");
    const line = ruleCheckoutWarning(rule("ready-for-agent", repo));
    expect(line).toContain('"ready-for-agent"');
    expect(line).toContain(repo);
    expect(line).toContain(noCheckoutWarning(repo));
    expect(line).toContain(`factory repo add ${repo} --path <dir>`);
  });
});

describe("TriggerCheckoutLog", () => {
  /**
   * Mutation: warn for every rule — the rule over the checked-out repo is named too.
   * Mutation: warn only for a slug with no row — the rule over the NULL-path row is not named.
   * Mutation: log nothing — the case never settles and times out.
   */
  it("logs one warning per rule whose repo has no local checkout, naming its label and repo", async () => {
    const unregistered = slug("unregistered");
    const pathless = slug("pathless");
    const ready = slug("ready");
    await setRepo(pathless, null);
    await setRepo(ready, "/srv/checkouts/ready");
    const lines = await bootLog(
      [
        rule("sentry-alerts", unregistered),
        rule("linear-ready", pathless),
        rule("docs", ready),
      ],
      (seen) => seen.filter((line) => line.startsWith("Warn")).length >= 2,
    );
    const warnings = lines.filter((line) => line.startsWith("Warn"));
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('"sentry-alerts"');
    expect(warnings[0]).toContain(unregistered);
    expect(warnings[1]).toContain('"linear-ready"');
    expect(warnings[1]).toContain(pathless);
    expect(lines.join("\n")).not.toContain('"docs"');
  });

  it("says every rule is covered when each repo has a checkout, and warns of none", async () => {
    const ready = slug("covered");
    await setRepo(ready, "/srv/checkouts/covered");
    const lines = await bootLog([rule("docs", ready)], (seen) =>
      seen.some((line) => line.includes("every rule's repo")),
    );
    expect(lines.filter((line) => line.startsWith("Warn"))).toEqual([]);
  });
});
