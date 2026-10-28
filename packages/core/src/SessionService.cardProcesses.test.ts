/**
 * A card's branch and PR across two API processes on one database (F13): the refusal that stops a
 * run taking the card's branch from under a busy run sees a run another process owns, and two
 * processes stepping the card's PR together open one PR — the second adopts the first's and answers
 * `already-open`.
 *
 * Two runtimes play the two processes, as `SessionService.follow.test.ts`'s do: each has its own
 * presence holder, its own in-process gates and its own session root. The second's root is a symlink
 * to the first's (`aliasOf`): presence tells the two homes apart by the root's spelling, while git,
 * which resolves symlinks, sees one session root, so C19's hand-over of the card's branch from one
 * process's worktree to the other's goes as it does within one.
 *
 * Real Postgres, real git worktrees, the real session service. GitHub is a fake `HttpClient` that
 * keeps the PRs it opened and refuses a second open PR for one head and base with `422`, as GitHub
 * does; the forge's git endpoint is a local bare repository. Nothing leaves the process
 * (docs/testing-third-parties.md).
 *
 * Postgres only, not mocked: `docker compose up -d --wait postgres`.
 */
import { BunServices } from "@effect/platform-bun";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoSlug, type SessionId } from "@repo/domain/Session";
import {
  BoardInstanceId,
  DEFAULT_DEFINITION_ID,
  DefinitionId,
} from "@repo/domain/Task";
import { createFauxModelAccess } from "@repo/harness";
import { DatabaseLive } from "@repo/storage-postgres";
import {
  Context,
  Effect,
  Layer,
  ManagedRuntime,
  Option,
  Redacted,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import { CredentialProvider, staticTokenProvider } from "./credentials";
import type { RepoRemote } from "./RepoRemote";
import { SessionService, SessionServiceLive } from "./SessionService";
import { TaskService, TaskServiceLive } from "./TaskService";

const runId = randomBytes(4).toString("hex");

const git = (cwd: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "f13",
      GIT_AUTHOR_EMAIL: "f13@localhost",
      GIT_COMMITTER_NAME: "f13",
      GIT_COMMITTER_EMAIL: "f13@localhost",
    },
  }).trim();

/** Every open the fake GitHub was asked for, and the PRs it holds open by `head->base`. */
const posts: Array<{ readonly head: string; readonly base: string }> = [];
const openPrs = new Map<
  string,
  { readonly number: number; readonly html_url: string }
>();
let nextNumber = 700;

/**
 * GitHub's PR endpoints as far as the step uses them: `POST /pulls` opens one — after a pause, so two
 * steps that both reach it overlap — or answers `422` when one is open for the head and base, and
 * `GET /pulls?head=owner:branch&base=` lists the open one (LOB-179's adoption).
 */
const fakeGitHub = HttpClient.make((request, url) =>
  Effect.gen(function* () {
    const [, , owner, repo] = url.pathname.split("/");
    const answer = (status: number, body: unknown) =>
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    if (request.method === "GET") {
      const head = (url.searchParams.get("head") ?? "").replace(/^[^:]*:/, "");
      const base = url.searchParams.get("base") ?? "";
      const found = openPrs.get(`${head}->${base}`);
      return answer(200, found === undefined ? [] : [found]);
    }
    const body =
      request.body._tag === "Uint8Array"
        ? (JSON.parse(new TextDecoder().decode(request.body.body)) as {
            head: string;
            base: string;
          })
        : { head: "", base: "" };
    posts.push({ head: body.head, base: body.base });
    yield* Effect.sleep(500);
    const key = `${body.head}->${body.base}`;
    if (openPrs.has(key)) {
      return answer(422, {
        message: "Validation Failed",
        errors: [
          {
            message: `A pull request already exists for ${owner}:${body.head}.`,
          },
        ],
      });
    }
    nextNumber += 1;
    const pr = {
      number: nextNumber,
      html_url: `https://github.com/${owner}/${repo}/pull/${nextNumber}`,
    };
    openPrs.set(key, pr);
    return answer(201, pr);
  }),
);

const forgeContext = Context.make(HttpClient.HttpClient, fakeGitHub).pipe(
  Context.add(
    CredentialProvider,
    staticTokenProvider(Option.some(Redacted.make("f13-fake-token"))),
  ),
);

/** The checkout the card's runs are cut from, and the bare repository standing in for the forge. */
const checkout = mkdtempSync(join(tmpdir(), "factory-f13-repo-"));
const forgeRepo = mkdtempSync(join(tmpdir(), "factory-f13-forge-"));
git(checkout, "init", "-q", "-b", "main");
writeFileSync(join(checkout, "README.md"), "f13\n");
git(checkout, "add", "README.md");
git(checkout, "commit", "-q", "-m", "init");
git(forgeRepo, "init", "-q", "--bare");
git(checkout, "push", "-q", forgeRepo, "main");

const repoRemote: RepoRemote = {
  fetchBase: (input) =>
    Effect.sync(() => {
      const sha = git(forgeRepo, "rev-parse", `refs/heads/${input.branch}`);
      const ref = `refs/remotes/factory/${input.branch}`;
      git(input.checkout, "fetch", "-q", forgeRepo, `${input.branch}:${ref}`);
      return { ref, sha };
    }),
  push: (input) =>
    Effect.sync(() => {
      const commit =
        input.commit ?? git(input.worktree, "rev-parse", input.branch);
      git(
        input.worktree,
        "push",
        "-q",
        forgeRepo,
        `${commit}:refs/heads/${input.branch}`,
      );
      return {
        ref: `refs/heads/${input.branch}`,
        sha: commit,
        outcome: "updated" as const,
      };
    }),
  defaultBranch: () => Effect.succeed("main"),
};

/** While this file exists, a run's command waits before it commits: a run held busy on purpose. */
const hold = join(mkdtempSync(join(tmpdir(), "factory-f13-hold-")), "hold");

const COMMAND = [
  `while [ -f ${hold} ]; do sleep 0.1; done`,
  "n=$(ls change-*.txt 2>/dev/null | wc -l | tr -d ' ')",
  "n=$((n+1))",
  'echo "change $n" > "change-$n.txt"',
  'git add -A && git -c user.email=f13@localhost -c user.name=f13 commit -qm "f13 change $n"',
  "echo faux-ok",
].join("; ");

const sessionRoot = mkdtempSync(join(tmpdir(), "factory-f13-sessions-"));

/** The same directory under another spelling: another process's home to presence, one root to git. */
const aliasOf = (root: string): string => {
  const alias = join(mkdtempSync(join(tmpdir(), "factory-f13-alias-")), "root");
  symlinkSync(root, alias);
  return alias;
};

const DatabaseLayer = Layer.mergeAll(DatabaseLive, BunServices.layer);

const processOver = (root: string) =>
  ManagedRuntime.make(
    TaskServiceLive.pipe(
      Layer.provideMerge(
        SessionServiceLive({
          model: createFauxModelAccess({ fauxCommand: COMMAND }).access,
          sessionRoot: root,
          repoRemote,
        }),
      ),
      Layer.provideMerge(DatabaseLayer),
    ),
  );

const first = processOver(sessionRoot);
const secondRoot = aliasOf(sessionRoot);
const second = processOver(secondRoot);

afterAll(async () => {
  rmSync(hold, { force: true });
  await second.dispose();
  await first.dispose();
});

const waitUntil = <A, E, R>(
  read: Effect.Effect<A, E, R>,
  done: (value: A) => boolean,
  label: string,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 1_200; attempt += 1) {
      const value = yield* read;
      if (done(value)) return value;
      yield* Effect.sleep(50);
    }
    return yield* Effect.die(new Error(`timed out waiting for ${label}`));
  });

let boards = 0;

/** A card in `building` on a board of its own, pinned to default version 4, which declares no caps. */
const cardInBuilding = (title: string) =>
  first.runPromise(
    Effect.gen(function* () {
      const service = yield* SessionService;
      const tasks = yield* TaskService;
      const sql = yield* SqlClient;
      boards += 1;
      const repo = RepoSlug.make(`f13-${runId}/card-${boards}`);
      yield* service.registerRepo({
        repo,
        url: `https://github.com/${repo}.git`,
        localPath: checkout,
      });
      const board = yield* tasks.createBoard({
        repo,
        definitionId: DefinitionId.make(DEFAULT_DEFINITION_ID),
      });
      const card = yield* tasks.create({
        boardId: BoardInstanceId.make(board.id),
        title,
        actor: "person:f13",
      });
      // No caps, so the busy run is the only thing that can stop a second start (C19's suite).
      yield* sql`
        UPDATE tasks SET "column" = 'building', definition_version = 4 WHERE id = ${card.id}
      `;
      return { taskId: card.id, repo };
    }),
  );

const worktreeOf = (repo: string, sessionId: string) =>
  join(sessionRoot, ...repo.split("/"), sessionId);

describe("a card's branch and PR across two API processes (F13)", () => {
  /**
   * Mutation this catches: see only the runs this process owns in `refuseBusyHolder` — the second
   * process's start takes the card's branch over from under the first's busy run. Mutation: read
   * `busy` without the lease — a run whose process died would refuse every start until its row
   * changed (here, the release of the hold is what lets the third start through).
   */
  it("refuses a start in one process while a run on the card's branch is busy in the other", async () => {
    const { taskId } = await cardInBuilding("busy elsewhere");
    const busyRun = await first.runPromise(
      Effect.gen(function* () {
        const service = yield* SessionService;
        // The first run cuts the card's branch and settles.
        const cut = yield* service.create({ taskId, taskColumn: "building" });
        yield* service.send({ sessionId: cut.id, content: "build it" });
        yield* waitUntil(
          service.get(cut.id),
          (snapshot) =>
            !snapshot.live.busy &&
            snapshot.entries.some((entry) => entry.kind === "assistant"),
          "the first run to settle",
        );
        // The second continues the branch and is held busy there.
        writeFileSync(hold, "");
        const busy = yield* service.create({ taskId, taskColumn: "building" });
        yield* service.send({ sessionId: busy.id, content: "fix it up" });
        yield* waitUntil(
          service.get(busy.id),
          (snapshot) => snapshot.live.busy,
          "the second run to turn busy",
        );
        return busy.id;
      }),
    );
    const refused = await second.runPromise(
      Effect.gen(function* () {
        const service = yield* SessionService;
        // What the other process wrote is what this one reads: its lease and its activity row.
        yield* waitUntil(
          Effect.flatMap(
            SqlClient,
            (sql) =>
              sql<{ status: string }>`
              SELECT status FROM session_activity WHERE session_id = ${busyRun}
            `,
          ),
          (rows) => rows[0]?.status === "busy",
          "the busy run's status to be written",
        );
        return yield* service
          .create({ taskId, taskColumn: "building" })
          .pipe(Effect.flip);
      }),
    );
    const runsWhileBusy = await first.runPromise(
      Effect.flatMap(
        SqlClient,
        (sql) =>
          sql`SELECT session_id FROM task_runs WHERE task_id = ${taskId}`,
      ),
    );

    // Released, the busy run settles, and the other process may start on the card again.
    rmSync(hold);
    await first.runPromise(
      Effect.gen(function* () {
        const service = yield* SessionService;
        yield* waitUntil(
          service.get(busyRun),
          (snapshot) =>
            !snapshot.live.busy &&
            snapshot.entries.some((entry) => entry.kind === "assistant"),
          "the busy run to settle",
        );
      }),
    );
    const started = await second.runPromise(
      Effect.flatMap(SessionService, (service) =>
        service.create({ taskId, taskColumn: "building" }),
      ),
    );

    expect(refused).toMatchObject({ code: "busy" });
    expect(refused.message).toContain(`run ${busyRun} of task ${taskId}`);
    expect(refused.message).toContain("in another process");
    // The refused start wrote no run.
    expect(runsWhileBusy).toHaveLength(2);
    expect(started.id).not.toBe(busyRun);
  }, 240_000);

  /**
   * Mutation this catches: take the card's PR gate in this process only — both processes read no
   * PR on the card, both ask GitHub, the second is refused `422` and adopts the PR through the
   * lookup as `opened` (LOB-179), and GitHub was asked twice.
   */
  it("opens one PR when two processes step the card's PR together; the other adopts it already-open", async () => {
    const { taskId, repo } = await cardInBuilding("two steps at once");
    // One run in each process, both on the card's branch, both with a commit and no PR yet.
    const one = await first.runPromise(
      Effect.flatMap(SessionService, (service) =>
        service.create({ taskId, taskColumn: "building" }),
      ),
    );
    writeFileSync(join(worktreeOf(repo, one.id), "one.txt"), "one\n");
    git(worktreeOf(repo, one.id), "add", "one.txt");
    git(worktreeOf(repo, one.id), "commit", "-q", "-m", "f13 one");
    const other = await second.runPromise(
      Effect.flatMap(SessionService, (service) =>
        service.create({ taskId, taskColumn: "building" }),
      ),
    );
    const branch = `factory/${one.id}`;
    const otherTree = join(secondRoot, ...repo.split("/"), other.id);
    expect(git(otherTree, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);
    writeFileSync(join(otherTree, "other.txt"), "other\n");
    git(otherTree, "add", "other.txt");
    git(otherTree, "commit", "-q", "-m", "f13 other");

    const before = posts.length;
    const step = (runtime: typeof first, sessionId: SessionId) =>
      runtime.runPromise(
        Effect.flatMap(SessionService, (service) =>
          service
            .openPullRequest({ sessionId, title: "two steps at once" })
            .pipe(Effect.provideContext(forgeContext)),
        ),
      );
    const [fromFirst, fromSecond] = await Promise.all([
      step(first, one.id),
      step(second, other.id),
    ]);
    const rows = await first.runPromise(
      Effect.flatMap(
        SqlClient,
        (sql) => sql<{ id: string; prUrl: string | null }>`
          SELECT id, pr_url FROM sessions WHERE id IN (${one.id}, ${other.id}) ORDER BY id
        `,
      ),
    );

    // GitHub was asked once, for the card's branch.
    expect(posts.slice(before)).toEqual([{ head: branch, base: "main" }]);
    const answers = [fromFirst, fromSecond];
    const pr = openPrs.get(`${branch}->main`);
    for (const answer of answers)
      expect(answer).toMatchObject({ number: pr?.number, url: pr?.html_url });
    expect(answers.map((answer) => answer.outcome).sort()).toEqual([
      "already-open",
      "opened",
    ]);
    expect(rows.map((row) => row.prUrl)).toEqual([pr?.html_url, pr?.html_url]);
  }, 240_000);
});
