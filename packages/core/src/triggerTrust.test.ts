/**
 * The trust gate's pure half and its GitHub port (S-trigger-trust-gating), with no database: which
 * author an allowlist names, which item is too old, which GitHub role is enough, and what GitHub's
 * collaborator-permission API is asked and how its answers read. The seam's use of it — the recorded
 * skip, the reclaim, the session never opened — is `TriggerService.trust.test.ts`, on Postgres.
 *
 * GitHub is a fake `HttpClient` that records each request and answers what the case says, so no
 * test reaches a forge (docs/testing-third-parties.md, the GitHub row).
 */
import { Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { describe, expect, it } from "vitest";
import type { RepoSlug } from "@repo/domain/Session";
import type {
  TriggerError,
  TriggerEvent,
  TriggerRule,
} from "@repo/domain/Trigger";
import { CredentialProvider, staticTokenProvider } from "./credentials";
import { GitHubAuthorPermissions } from "./GitHub";
import type { RoutedRule } from "./TriggerRoutes";
import {
  authorListed,
  authorText,
  createdAfterRefusal,
  type GitHubRole,
  githubRoleAtLeast,
  githubRoleOf,
  TriggerAuthorPermissions,
  type TriggerAuthorPermissionsShape,
  trustRefusal,
} from "./triggerTrust";

const repo = "acme/widgets" as RepoSlug;

const event = (over: Partial<TriggerEvent> = {}): TriggerEvent => ({
  source: "github",
  key: "acme/widgets#7",
  action: "create",
  title: "Fix it",
  body: "",
  labels: ["factory"],
  repo,
  author: { id: "583231", login: "octocat" },
  createdAt: "2026-10-20T00:00:00Z",
  ...over,
});

const routed = (
  trust: TriggerRule["trust"],
  over: Partial<RoutedRule> = {},
): RoutedRule => ({
  rule: { label: "factory", repo, prompt: "{{title}}", trust },
  origin: "route trr_test",
  ...over,
});

/** A permission port answering one role per login, counting what it was asked. */
const rolesBy = (roles: Record<string, GitHubRole>) => {
  const asked: Array<string> = [];
  const port: TriggerAuthorPermissionsShape = {
    githubRole: ({ login }) =>
      Effect.sync(() => {
        asked.push(login);
        return roles[login] ?? "none";
      }),
  };
  return { asked, port: Option.some(port) };
};

describe("the allowlist", () => {
  it("names an author by id exactly, and by login without regard to case", () => {
    const author = { id: "583231", login: "Octocat" };
    expect(authorListed(["583231"], author)).toBe(true);
    expect(authorListed(["octocat"], author)).toBe(true);
    expect(authorListed(["OCTOCAT"], author)).toBe(true);
    // An id is not a login: case is not folded on it, and a prefix is not a match.
    expect(authorListed(["58323"], author)).toBe(false);
    expect(authorListed(["octo"], author)).toBe(false);
    expect(authorListed([], author)).toBe(false);
    expect(authorListed(["user-a"], { id: "USER-A" })).toBe(false);
  });

  it("names an author in a reason by handle and id, or by id alone", () => {
    expect(authorText({ id: "583231", login: "octocat" })).toBe(
      "octocat (583231)",
    );
    expect(authorText({ id: "user-1", name: "Ada" })).toBe("Ada (user-1)");
    expect(authorText({ id: "alice", login: "alice" })).toBe("alice");
  });
});

describe("created after enable", () => {
  it("refuses an item created before the rule was enabled, naming both instants", () => {
    const reason = createdAfterRefusal(
      routed(
        { createdAfter: "enabled" },
        { enabledAt: "2026-10-27T00:00:00.000Z" },
      ),
      event({ createdAt: "2026-10-20T00:00:00Z" }),
    );
    expect(reason).toBe(
      'created before the rule was enabled: acme/widgets#7 was created at 2026-10-20T00:00:00Z, and rule "factory" (route trr_test) takes only items created from 2026-10-27T00:00:00.000Z',
    );
  });

  it("admits an item created at or after the instant, and a rule that does not ask", () => {
    const at = "2026-10-27T00:00:00.000Z";
    expect(
      createdAfterRefusal(
        routed({ createdAfter: "enabled" }, { enabledAt: at }),
        event({ createdAt: at }),
      ),
    ).toBeUndefined();
    expect(
      createdAfterRefusal(
        routed({ createdAfter: at }),
        event({ createdAt: "2026-10-28T00:00:00Z" }),
      ),
    ).toBeUndefined();
    expect(
      createdAfterRefusal(
        routed(undefined),
        event({ createdAt: "1999-01-01T00:00:00Z" }),
      ),
    ).toBeUndefined();
  });

  it("refuses an item the source gives no creation time for: it cannot be told apart from an old one", () => {
    const { createdAt: _createdAt, ...undated } = event();
    expect(
      createdAfterRefusal(
        routed({ createdAfter: "2026-10-27T00:00:00Z" }),
        undated,
      ),
    ).toMatch(/^created before the rule was enabled, or cannot be told apart/);
  });

  it("refuses everything through an `enabled` rule that has no enable time, saying how to fix it", () => {
    expect(
      createdAfterRefusal(routed({ createdAfter: "enabled" }), event()),
    ).toMatch(/has no enable time .* give trust.createdAfter an instant/);
  });
});

describe("GitHub roles", () => {
  it("reads role_name when it is a base role, else the legacy permission, else none", () => {
    expect(githubRoleOf({ permission: "write", role_name: "maintain" })).toBe(
      "maintain",
    );
    expect(githubRoleOf({ permission: "read", role_name: "triage" })).toBe(
      "triage",
    );
    // A custom role reads as the base `permission` it extends.
    expect(githubRoleOf({ permission: "write", role_name: "deployer" })).toBe(
      "write",
    );
    expect(githubRoleOf({})).toBe("none");
  });

  it("orders roles as GitHub does", () => {
    expect(githubRoleAtLeast("write", "write")).toBe(true);
    expect(githubRoleAtLeast("admin", "write")).toBe(true);
    expect(githubRoleAtLeast("maintain", "write")).toBe(true);
    expect(githubRoleAtLeast("triage", "write")).toBe(false);
    expect(githubRoleAtLeast("read", "triage")).toBe(false);
    expect(githubRoleAtLeast("none", "triage")).toBe(false);
  });
});

describe("trustRefusal", () => {
  const run = (effect: Effect.Effect<string | undefined, TriggerError>) =>
    Effect.runPromise(effect);

  it("admits every author through a rule with no gate", async () => {
    expect(
      await run(trustRefusal(routed(undefined), event(), Option.none())),
    ).toBeUndefined();
  });

  it("refuses an author outside the allowlist, naming them", async () => {
    expect(
      await run(
        trustRefusal(
          routed({ authors: ["alice"] }),
          event({ author: { id: "666", login: "mallory" } }),
          Option.none(),
        ),
      ),
    ).toBe(
      'untrusted author mallory (666): rule "factory" (route trr_test) admits only the authors [alice]',
    );
  });

  it("refuses an event that names no author", async () => {
    const { author: _author, ...anonymous } = event({ source: "linear" });
    expect(
      await run(
        trustRefusal(routed({ authors: ["alice"] }), anonymous, Option.none()),
      ),
    ).toBe(
      'untrusted author: the linear event names no author, and rule "factory" (route trr_test) admits only the authors [alice]',
    );
  });

  it("asks GitHub for an author the list does not name, and refuses one below the role", async () => {
    const roles = rolesBy({ reader: "read", writer: "write" });
    const trust = { authors: ["alice"], githubPermission: "write" as const };
    expect(
      await run(
        trustRefusal(
          routed(trust),
          event({ author: { id: "1", login: "reader" } }),
          roles.port,
        ),
      ),
    ).toBe(
      'untrusted author reader (1): rule "factory" (route trr_test) admits only the authors [alice] or GitHub users with write or higher on the repo; their role on acme/widgets is read',
    );
    expect(
      await run(
        trustRefusal(
          routed(trust),
          event({ author: { id: "2", login: "writer" } }),
          roles.port,
        ),
      ),
    ).toBeUndefined();
    // A listed author costs no lookup.
    expect(
      await run(
        trustRefusal(
          routed(trust),
          event({ author: { id: "3", login: "alice" } }),
          roles.port,
        ),
      ),
    ).toBeUndefined();
    expect(roles.asked).toEqual(["reader", "writer"]);
  });

  it("checks the age before the author, so a too-old item costs no lookup", async () => {
    const roles = rolesBy({ writer: "write" });
    const reason = await run(
      trustRefusal(
        routed({
          githubPermission: "write",
          createdAfter: "2026-10-27T00:00:00Z",
        }),
        event({ author: { id: "2", login: "writer" } }),
        roles.port,
      ),
    );
    expect(reason).toMatch(/^created before the rule was enabled: /);
    expect(roles.asked).toEqual([]);
  });

  it("refuses a non-GitHub author through a rule that admits only by GitHub role", async () => {
    expect(
      await run(
        trustRefusal(
          routed({ githubPermission: "write" }),
          event({ source: "linear", author: { id: "user-1", name: "Ada" } }),
          rolesBy({}).port,
        ),
      ),
    ).toMatch(/a linear author has no GitHub role to check$/);
  });

  it("fails rather than admits when the rule needs a GitHub role and no port is wired", async () => {
    const exit = await Effect.runPromiseExit(
      trustRefusal(
        routed({ githubPermission: "write" }),
        event(),
        Option.none(),
      ),
    );
    expect(exit._tag).toBe("Failure");
    expect(JSON.stringify(exit)).toContain("author-check");
  });
});

/** A fake GitHub answering the permission endpoint with `status` and `body`, recording each request. */
const fakeGitHub = (status: number, body: unknown) => {
  const requests: Array<{
    readonly path: string;
    readonly authorization: string | undefined;
  }> = [];
  const Json = Schema.fromJsonString(Schema.Unknown);
  const client = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.gen(function* () {
        requests.push({
          path: url.pathname,
          authorization: request.headers["authorization"],
        });
        const text = yield* Schema.encodeEffect(Json)(body).pipe(Effect.orDie);
        return HttpClientResponse.fromWeb(
          request,
          new Response(text, {
            status,
            headers: { "content-type": "application/json" },
          }),
        );
      }),
    ),
  );
  const credentials = Layer.succeed(
    CredentialProvider,
    CredentialProvider.of(
      staticTokenProvider(Option.some(Redacted.make("ghs-test-token"))),
    ),
  );
  const layer = GitHubAuthorPermissions({
    apiUrl: "http://127.0.0.1:9413",
  }).pipe(Layer.provide(Layer.merge(client, credentials)));
  const roleOf = (login: string) =>
    Effect.runPromiseExit(
      Effect.gen(function* () {
        const permissions = yield* TriggerAuthorPermissions;
        return yield* permissions.githubRole({ repo, login });
      }).pipe(Effect.provide(layer)),
    );
  return { requests, roleOf };
};

describe("GitHubAuthorPermissions", () => {
  it("asks the collaborator-permission endpoint with the repo's token, and reads the role", async () => {
    const github = fakeGitHub(200, {
      permission: "write",
      role_name: "maintain",
      user: { login: "octo cat" },
    });
    const exit = await github.roleOf("octo cat");
    expect(exit).toMatchObject({ _tag: "Success", value: "maintain" });
    expect(github.requests).toEqual([
      {
        path: "/repos/acme/widgets/collaborators/octo%20cat/permission",
        authorization: "Bearer ghs-test-token",
      },
    ]);
  });

  it("reads a 404 as no role: GitHub knows no such collaborator", async () => {
    expect(
      await fakeGitHub(404, { message: "Not Found" }).roleOf("ghost"),
    ).toMatchObject({
      _tag: "Success",
      value: "none",
    });
  });

  it("fails an answer it cannot trust with author-check, never a role", async () => {
    for (const [status, body] of [
      [500, { message: "boom" }],
      [403, { message: "rate limited" }],
    ] as const) {
      const exit = await fakeGitHub(status, body).roleOf("octocat");
      expect(exit._tag).toBe("Failure");
      expect(JSON.stringify(exit)).toContain("author-check");
    }
  });
});
