/**
 * Plan, apply and read back the rulesets against a loopback GitHub (LOB-30).
 *
 * No GitHub: `../testing/githubFake.ts` answers the rulesets routes as GitHub documents them, over
 * real HTTP on an ephemeral loopback port, and the client is Effect's fetch client pointed at it.
 * A change made "in the UI" is a request straight to the fake with the admin token, the way someone
 * with the repo's settings page would make it — so the read-back is tested against exactly the
 * edits it exists to catch: a deleted ruleset, a rule switched off, a bypass actor, a weaker
 * enforcement, a narrowed pattern.
 */
import { Effect, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type GitHubFake, startGitHubFake } from "../testing/githubFake";
import { makeRulesetsClient, type RulesetsClient } from "./github";
import { rulesetPolicy } from "./policy";
import { applyPlan, planRulesets, verifyRulesets } from "./reconcile";

const ADMIN = "admin-token-for-tests";
const WORKER = "worker-token-for-tests";
const POLICY = rulesetPolicy();
const MAIN = "factory: the default branch is PR-only";
const SESSIONS = "factory: factory/** is append-only";

let root: string;
let forge: GitHubFake;
let repoCount = 0;
let repo: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "rulesets-reconcile-"));
  forge = await startGitHubFake({
    root,
    workerToken: WORKER,
    adminToken: ADMIN,
  });
});

afterAll(async () => {
  await forge.close();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  repoCount += 1;
  repo = `acme/app-${repoCount}`;
});

const run = <A, E>(effect: Effect.Effect<A, E, never>) =>
  Effect.runPromise(effect);

const clientFor = (token: string) =>
  run(
    makeRulesetsClient({
      apiUrl: forge.url,
      token: Redacted.make(token),
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

/** One request "from the settings page": straight to the fake as the admin. */
const ui = async (method: string, path: string, body?: unknown) => {
  expect(await forge.editAsAdmin(repo, method, path, body)).toBeLessThan(300);
};

const idOf = (name: string) => {
  const found = forge.rulesets(repo).find((ruleset) => ruleset.name === name);
  if (found === undefined) throw new Error(`no ruleset named ${name}`);
  return found.id;
};

const applied = async (client: RulesetsClient) => {
  const plan = await run(planRulesets(client, repo, POLICY));
  return run(applyPlan(client, plan, POLICY));
};

const writes = () =>
  forge.requests.filter(
    (request) =>
      request.path.startsWith(`/repos/${repo}/`) && request.method !== "GET",
  ).length;

describe("plan and apply", () => {
  it("creates both rulesets on a bare repo, reads them back clean, and is idempotent", async () => {
    const client = await clientFor(ADMIN);
    const before = await run(verifyRulesets(client, repo, POLICY));
    expect(before.ok).toBe(false);
    expect(before.findings).toEqual([
      `missing: "${MAIN}" is not on ${repo} (deleted, or never applied)`,
      `missing: "${SESSIONS}" is not on ${repo} (deleted, or never applied)`,
    ]);

    const first = await applied(client);
    expect(first.map((change) => [change.action, change.name])).toEqual([
      ["created", MAIN],
      ["created", SESSIONS],
    ]);
    // What landed is the declared body, not just two names.
    const stored = forge
      .rulesets(repo)
      .find((ruleset) => ruleset.name === SESSIONS);
    expect(stored?.conditions?.ref_name?.include).toEqual([
      "refs/heads/factory/**",
    ]);
    expect(stored?.rules.map((rule) => rule.type)).toEqual([
      "deletion",
      "non_fast_forward",
    ]);
    expect(stored?.bypass_actors).toEqual([]);

    const after = await run(verifyRulesets(client, repo, POLICY));
    expect(after).toMatchObject({ ok: true, findings: [] });

    const writesBefore = writes();
    expect(await applied(client)).toEqual([]);
    expect(writes()).toBe(writesBefore);
  });
});

describe("the read-back", () => {
  it("fails when a ruleset is deleted, naming it, and apply puts it back", async () => {
    const client = await clientFor(ADMIN);
    await applied(client);
    await ui("DELETE", `/${idOf(SESSIONS)}`);

    const verification = await run(verifyRulesets(client, repo, POLICY));
    expect(verification.ok).toBe(false);
    expect(verification.findings).toEqual([
      `missing: "${SESSIONS}" is not on ${repo} (deleted, or never applied)`,
    ]);

    expect((await applied(client)).map((change) => change.action)).toEqual([
      "created",
    ]);
    expect((await run(verifyRulesets(client, repo, POLICY))).ok).toBe(true);
  });

  it.each([
    {
      edit: "an App added as a bypass actor",
      body: {
        bypass_actors: [
          { actor_type: "Integration", actor_id: 4242, bypass_mode: "always" },
        ],
      },
      finding: "bypass actor Integration 4242 (always), declared none",
    },
    {
      edit: "enforcement moved to evaluate",
      body: { enforcement: "evaluate" },
      finding: "enforcement is evaluate, declared active",
    },
    {
      edit: "the force-push rule switched off",
      body: { rules: [{ type: "deletion" }] },
      finding: "rule non_fast_forward is missing",
    },
    {
      edit: "the pattern narrowed to one segment",
      body: {
        conditions: {
          ref_name: { include: ["refs/heads/factory/*"], exclude: [] },
        },
      },
      finding:
        "includes [refs/heads/factory/*], declared [refs/heads/factory/**]",
    },
    {
      edit: "an exclusion carved out",
      body: {
        conditions: {
          ref_name: {
            include: ["refs/heads/factory/**"],
            exclude: ["refs/heads/factory/scratch"],
          },
        },
      },
      finding: "excludes [refs/heads/factory/scratch], declared []",
    },
    {
      edit: "an undeclared rule added",
      body: {
        rules: [
          { type: "deletion" },
          { type: "non_fast_forward" },
          { type: "creation" },
        ],
      },
      finding: "rule creation is not declared",
    },
  ])("fails on $edit, and apply restores it", async ({ body, finding }) => {
    const client = await clientFor(ADMIN);
    await applied(client);
    const id = idOf(SESSIONS);
    await ui("PUT", `/${id}`, body);

    const verification = await run(verifyRulesets(client, repo, POLICY));
    expect(verification.ok).toBe(false);
    expect(verification.findings).toEqual([`drift: "${SESSIONS}": ${finding}`]);

    expect(await applied(client)).toEqual([
      { action: "updated", name: SESSIONS, id },
    ]);
    expect((await run(verifyRulesets(client, repo, POLICY))).ok).toBe(true);
  });

  it("fails on a weakened PR rule parameter, and ignores parameters GitHub defaults", async () => {
    const client = await clientFor(ADMIN);
    await applied(client);
    const pullRequest = (parameters: Record<string, unknown>) => ({
      rules: [
        { type: "deletion" },
        { type: "non_fast_forward" },
        { type: "pull_request", parameters },
      ],
    });
    const declared = {
      required_approving_review_count: 1,
      dismiss_stale_reviews_on_push: true,
      require_code_owner_review: false,
      require_last_push_approval: true,
      required_review_thread_resolution: false,
    };
    await ui(
      "PUT",
      `/${idOf(MAIN)}`,
      pullRequest({
        ...declared,
        allowed_merge_methods: ["merge", "squash", "rebase"],
      }),
    );
    expect((await run(verifyRulesets(client, repo, POLICY))).ok).toBe(true);

    await ui(
      "PUT",
      `/${idOf(MAIN)}`,
      pullRequest({ ...declared, required_approving_review_count: 0 }),
    );
    expect((await run(verifyRulesets(client, repo, POLICY))).findings).toEqual([
      `drift: "${MAIN}": rule pull_request: required_approving_review_count is 0, declared 1`,
    ]);
  });

  it("does not pass a token that cannot see who bypasses", async () => {
    await applied(await clientFor(ADMIN));
    const verification = await run(
      verifyRulesets(await clientFor(WORKER), repo, POLICY),
    );
    expect(verification.ok).toBe(false);
    expect(verification.findings).toEqual(
      [MAIN, SESSIONS].map(
        (name) =>
          `drift: "${name}": bypass_actors was not answered (the token cannot read it), so no bypass is proven absent`,
      ),
    );
  });
});

describe("ownership", () => {
  it("deletes an undeclared factory-prefixed ruleset and never touches anyone else's", async () => {
    const client = await clientFor(ADMIN);
    const foreign = {
      name: "release branches",
      enforcement: "active",
      rules: [{ type: "deletion" }],
    };
    await ui("POST", "", foreign);
    await ui("POST", "", { ...foreign, name: "factory: retired" });

    const plan = await run(planRulesets(client, repo, POLICY));
    expect(plan.changes.map((change) => [change.action, change.name])).toEqual([
      ["create", MAIN],
      ["create", SESSIONS],
      ["delete", "factory: retired"],
    ]);
    await run(applyPlan(client, plan, POLICY));
    expect(
      forge
        .rulesets(repo)
        .map((ruleset) => ruleset.name)
        .sort(),
    ).toEqual([MAIN, SESSIONS, "release branches"].sort());
  });

  it("finds its rulesets past the first page", async () => {
    const client = await clientFor(ADMIN);
    for (let index = 0; index < 100; index += 1)
      await ui("POST", "", {
        name: `other ${index}`,
        enforcement: "disabled",
        rules: [],
      });
    await applied(client);
    expect(writes()).toBe(102);
    const pages = forge.requests.filter(
      (request) =>
        request.path.startsWith(`/repos/${repo}/rulesets?`) &&
        request.path.includes("page=2"),
    );
    expect(pages.length).toBeGreaterThan(0);
    expect((await run(verifyRulesets(client, repo, POLICY))).ok).toBe(true);
    // A second apply finds both on page 2 rather than creating duplicates.
    expect(await applied(client)).toEqual([]);
  });
});

describe("failures", () => {
  it("names the call and GitHub's status when the token is refused", async () => {
    const client = await clientFor("not-a-token");
    const error = await run(Effect.flip(verifyRulesets(client, repo, POLICY)));
    expect(error).toMatchObject({
      _tag: "RulesetsApiError",
      operation: "list",
      repo,
      status: 401,
      message: "GitHub answered HTTP 401: Bad credentials",
    });
  });

  it("cannot write with the factory's own token", async () => {
    const client = await clientFor(WORKER);
    const plan = await run(planRulesets(client, repo, POLICY));
    const error = await run(Effect.flip(applyPlan(client, plan, POLICY)));
    expect(error).toMatchObject({
      operation: "create",
      status: 403,
      message:
        "GitHub answered HTTP 403: Resource not accessible by integration",
    });
    expect(forge.rulesets(repo)).toEqual([]);
  });

  it("carries GitHub's reason for a refusal, and survives a body that has none", async () => {
    // GitHub's own shapes: a 422 with an `errors` list, a 403 a plan answers, and a body that is
    // not JSON at all (a proxy's error page), which must still leave the status.
    const answers: Record<string, { status: number; body: string }> = {
      "/repos/acme/invalid/rulesets": {
        status: 422,
        body: JSON.stringify({
          message: "Validation Failed",
          errors: [
            { resource: "Ruleset", field: "rules", code: "invalid" },
            "Invalid rule 'pull_request': required_approving_review_count must be at most 10",
          ],
        }),
      },
      "/repos/acme/private/rulesets": {
        status: 403,
        body: JSON.stringify({
          message:
            "Upgrade to GitHub Pro or make this repository public to enable this feature.",
        }),
      },
      "/repos/acme/proxied/rulesets": {
        status: 502,
        body: "<html>Bad Gateway</html>",
      },
    };
    const server = createServer((req, res) => {
      const answer = answers[(req.url ?? "").split("?")[0] ?? ""];
      res.writeHead(answer?.status ?? 404, {
        "content-type": "application/json",
      });
      res.end(answer?.body ?? "{}");
    });
    await once(server.listen(0, "127.0.0.1"), "listening");
    try {
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("the refusing server did not bind a TCP port");
      const client = await run(
        makeRulesetsClient({
          apiUrl: `http://127.0.0.1:${address.port}`,
          token: Redacted.make(ADMIN),
        }).pipe(Effect.provide(FetchHttpClient.layer)),
      );
      const [declared] = POLICY;
      if (declared === undefined) throw new Error("no declared ruleset");
      expect(
        await run(Effect.flip(client.create("acme/invalid", declared))),
      ).toMatchObject({
        status: 422,
        message:
          "GitHub answered HTTP 422: Validation Failed; rules invalid; Invalid rule 'pull_request': required_approving_review_count must be at most 10",
      });
      expect(await run(Effect.flip(client.list("acme/private")))).toMatchObject(
        {
          status: 403,
          message:
            "GitHub answered HTTP 403: Upgrade to GitHub Pro or make this repository public to enable this feature.",
        },
      );
      expect(await run(Effect.flip(client.list("acme/proxied")))).toMatchObject(
        { status: 502, message: "GitHub answered HTTP 502" },
      );
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
