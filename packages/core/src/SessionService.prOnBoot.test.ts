/**
 * A settle no process saw still gets its PR step: the boot's sweep (F16, `settlePullRequestsAtBoot`).
 *
 * The settle-time step (C18) is forked only where a process sees a run go idle, so a process that
 * dies between a run settling and its step — or inside the step, before `factory.pr` commits — left
 * the session with no PR. The kill here is a real one: `SessionService.prOnBoot.kill-fixture.ts` is a
 * separate process whose card run settles and whose step then holds inside its GitHub call, and the
 * case SIGKILLs it there. Each "boot" after it is a runtime in this process over the same database
 * and session root, as `SessionService.test.ts`'s "a run across a kill" boots one.
 *
 * Real Postgres, real git worktrees, the faux model; GitHub is a fake `HttpClient` that records what
 * it was asked, and nothing leaves the process. The model's one `bash` call commits as many files as
 * its repository's `f16-files` marker says (none without one), so each repository is one outcome.
 *
 * Postgres only, not mocked: `docker compose up -d --wait postgres`.
 */
import { BunServices } from "@effect/platform-bun";
import { type ChildProcess, execSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RepoSlug,
  SessionId as SessionIdSchema,
  type SessionId,
  type SessionSnapshot,
} from "@repo/domain/Session";
import {
  BoardInstanceId,
  DEFAULT_DEFINITION_ID,
  DefinitionId,
} from "@repo/domain/Task";
import { createFauxModelAccess, readRecordedPullRequest } from "@repo/harness";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
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
import { describe, expect, it } from "vitest";
import { CredentialProvider, staticTokenProvider } from "./credentials";
import type { SettleDecision } from "./prOnSettle";
import { SessionService, SessionServiceLive } from "./SessionService";
import { TaskService, TaskServiceLive } from "./TaskService";

const runId = randomBytes(4).toString("hex");

/** Every create the fake forge was asked for: the head it named. */
const forge: Array<{ readonly head: string }> = [];
let nextNumber = 500;

const fakeForge = HttpClient.make((request, url) =>
  Effect.sync(() => {
    const body =
      request.body._tag === "Uint8Array"
        ? new TextDecoder().decode(request.body.body)
        : "{}";
    const sent = JSON.parse(body) as Record<string, unknown>;
    const head = sent["head"];
    forge.push({ head: typeof head === "string" ? head : "" });
    nextNumber += 1;
    const [, , owner, repo] = url.pathname.split("/");
    return HttpClientResponse.fromWeb(
      request,
      new Response(
        JSON.stringify({
          number: nextNumber,
          html_url: `https://github.com/${owner}/${repo}/pull/${nextNumber}`,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
  }),
);

const pullRequestOnSettle = Context.make(HttpClient.HttpClient, fakeForge).pipe(
  Context.add(
    CredentialProvider,
    staticTokenProvider(Option.some(Redacted.make("f16-fake-token"))),
  ),
);

/** Every settle decision any boot reached, in order. */
const decisions: Array<{
  readonly sessionId: SessionId;
  readonly decision: SettleDecision;
}> = [];

/** A checkout whose `main` carries an `f16-files` marker of `files` (none for 0). */
const fixtureRepo = (files: number): string => {
  const root = mkdtempSync(join(tmpdir(), "factory-f16-repo-"));
  const git = (command: string) =>
    execSync(command, { cwd: root, stdio: "ignore" });
  git("git init -b main");
  git("git config user.email f16@localhost");
  git("git config user.name f16");
  if (files > 0) {
    writeFileSync(join(root, "f16-files"), `${files}\n`);
    git("git add f16-files");
  }
  git("git commit --allow-empty -m init");
  return root;
};

/** The run's one command: commit `f16-files` files, or nothing. */
const COMMAND = [
  "n=$(cat f16-files 2>/dev/null || echo 0)",
  "i=0",
  'while [ "$i" -lt "$n" ]; do i=$((i+1)); echo x > "change-$i.txt"; done',
  'if [ "$n" -gt 0 ]; then git add -A && git -c user.email=f16@localhost -c user.name=f16 commit -qm f16; fi',
  "echo faux-ok",
].join("; ");

/**
 * One process's session service over `sessionRoot`: with the settle-time step (`forge`) or without
 * it, as a deployment with no forge pair runs — which settles runs and steps none.
 */
const boot = (sessionRoot: string, withForge: boolean) =>
  ManagedRuntime.make(
    TaskServiceLive.pipe(
      Layer.provideMerge(
        SessionServiceLive({
          model: createFauxModelAccess({ fauxCommand: COMMAND }).access,
          sessionRoot,
          prCap: { maxFiles: 2, maxLines: 1_000 },
          ...(withForge
            ? {
                pullRequestOnSettle,
                onPullRequestSettled: (sessionId, decision) =>
                  Effect.sync(() => {
                    decisions.push({ sessionId, decision });
                  }),
              }
            : {}),
        }),
      ),
      Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)),
    ),
  );

type Boot = ReturnType<typeof boot>;

/**
 * Run `effect` on a fresh boot over `sessionRoot`, then shut that process down: the runtime's
 * disposal closes every owner and gives the claims back, as the API's shutdown does.
 */
const onBoot = async <A, E>(
  sessionRoot: string,
  withForge: boolean,
  effect: Effect.Effect<A, E, SessionService | TaskService | SqlClient>,
): Promise<A> => {
  const runtime: Boot = boot(sessionRoot, withForge);
  try {
    return await runtime.runPromise(effect);
  } finally {
    await runtime.dispose();
  }
};

const waitUntil = <A, E, R>(
  read: Effect.Effect<A, E, R>,
  done: (value: A) => boolean,
  label: string,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const value = yield* read;
      if (done(value)) return value;
      yield* Effect.sleep(50);
    }
    return yield* Effect.die(new Error(`timed out waiting for ${label}`));
  });

const settled = (sessionId: SessionId) =>
  Effect.gen(function* () {
    const service = yield* SessionService;
    return yield* waitUntil(
      service.get(sessionId),
      (snapshot) =>
        !snapshot.live.busy &&
        snapshot.entries.some((entry) => entry.kind === "assistant"),
      `session ${sessionId}'s run to settle`,
    );
  });

const decisionsOf = (sessionId: SessionId) =>
  decisions
    .filter((entry) => entry.sessionId === sessionId)
    .map((entry) => entry.decision);

const decided = (sessionId: SessionId, count = 1) =>
  waitUntil(
    Effect.sync(() => decisionsOf(sessionId)),
    (made) => made.length >= count,
    `session ${sessionId}'s settle decision ${count}`,
  );

/** The `factory.pr` the session's log records, read with no owner. */
const recordedPr = (sessionId: SessionId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const storage = yield* Effect.promise(() =>
      PostgresStorage.reader(sql, sessionId),
    );
    return yield* readRecordedPullRequest(storage).pipe(
      Effect.ensuring(Effect.promise(() => storage.dispose())),
    );
  });

const prUrlOf = (sessionId: SessionId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ readonly prUrl: string | null }>`
      SELECT pr_url FROM sessions WHERE id = ${sessionId}
    `;
    return rows[0]?.prUrl ?? null;
  });

const said = (snapshot: SessionSnapshot, text: string) =>
  snapshot.entries.filter((entry) => entry.text.includes(text));

const createsFor = (sessionId: SessionId) =>
  forge.filter((entry) => entry.head === `factory/${sessionId}`).length;

const register = (files: number, kind: string) =>
  Effect.gen(function* () {
    const service = yield* SessionService;
    const repo = RepoSlug.make(`f16-${runId}/${kind}`);
    yield* service.registerRepo({
      repo,
      url: `https://github.com/${repo}.git`,
      localPath: fixtureRepo(files),
    });
    return repo;
  });

/** A card in `building` on a new board over `repo`, and a run started on it. */
const buildRun = (repo: RepoSlug, parked = false) =>
  Effect.gen(function* () {
    const tasks = yield* TaskService;
    const service = yield* SessionService;
    const sql = yield* SqlClient;
    const board = yield* tasks.createBoard({
      repo,
      definitionId: DefinitionId.make(DEFAULT_DEFINITION_ID),
    });
    const card = yield* tasks.create({
      boardId: BoardInstanceId.make(board.id),
      title: `build on ${repo}`,
      actor: "person:f16",
    });
    yield* sql`UPDATE tasks SET "column" = 'building' WHERE id = ${card.id}`;
    const created = yield* service.create({
      taskId: card.id,
      taskColumn: "building",
    });
    if (parked) {
      yield* sql`
        UPDATE tasks SET blocked_reason = 'needs_input', blocked_column = 'building',
          blocked_since = now()
        WHERE id = ${card.id}
      `;
    }
    yield* service.send({ sessionId: created.id, content: "build it" });
    return { taskId: card.id, sessionId: created.id };
  });

/** What a boot's sweep stepped among `ids`: the sweep reads the whole table, other suites' too. */
const sweptAmong = (ids: ReadonlyArray<SessionId>) =>
  Effect.gen(function* () {
    const service = yield* SessionService;
    const stepped = yield* service.settlePullRequestsAtBoot;
    return stepped.filter((id) => ids.includes(id));
  });

const CASE = 180_000;

describe("a settle no process saw gets its PR step at boot (F16)", () => {
  const fixture = fileURLToPath(
    new URL("./SessionService.prOnBoot.kill-fixture.ts", import.meta.url),
  );

  type Doomed = {
    readonly child: ChildProcess;
    readonly sessionId: SessionId;
    readonly taskId: string;
  };
  /** Start the fixture and answer once its settle's step holds inside the GitHub call. */
  const startDoomed = (root: string, repo: string, checkout: string) =>
    Effect.callback<Doomed>((resume) => {
      const child = spawn("bun", [fixture, root, repo, checkout], {
        // oxlint-disable-next-line effecttsgo/process-env -- a test hands its child process an environment.
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        err += chunk.toString();
      });
      child.stdout?.on("data", (chunk: Buffer) => {
        out += chunk.toString();
        const line = out.split("\n").find((each) => each.startsWith("READY "));
        if (line === undefined) return;
        const [, sessionId, taskId] = line.split(" ");
        resume(
          Effect.succeed({
            child,
            sessionId: SessionIdSchema.make(sessionId ?? ""),
            taskId: taskId ?? "",
          }),
        );
      });
      child.on("exit", (code) => {
        resume(
          Effect.die(
            new Error(`the doomed process exited (${code}): ${out}${err}`),
          ),
        );
      });
      return Effect.sync(() => {
        child.kill("SIGKILL");
      });
    }).pipe(Effect.timeout("90 seconds"));

  const killed = (child: ChildProcess) =>
    Effect.callback<NodeJS.Signals | null>((resume) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resume(Effect.succeed(child.signalCode));
        return;
      }
      child.on("exit", (_code, signal) => resume(Effect.succeed(signal)));
      child.kill("SIGKILL");
    });

  /**
   * Mutation: drop `settlePullRequestsAtBoot` (or never call `settlePullRequest` from it) — the
   * killed run's session has no PR after the boot.
   * Mutation: drop `s.pr_url IS NULL` and the declaration's PR check from the sweep — the second boot
   * steps the session again (an `up-to-date` decision).
   */
  it(
    "a card run killed inside its settle's PR step opens its PR once at the next boot, and not again at the one after",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "factory-f16-kill-"));
      const repo = `f16-${runId}/killed`;
      const doomed = await Effect.runPromise(
        startDoomed(root, repo, fixtureRepo(0)),
      );
      const signal = await Effect.runPromise(killed(doomed.child));

      const left = await onBoot(
        root,
        false,
        Effect.gen(function* () {
          return {
            prUrl: yield* prUrlOf(doomed.sessionId),
            recorded: yield* recordedPr(doomed.sessionId),
          };
        }),
      );
      const first = await onBoot(
        root,
        true,
        Effect.gen(function* () {
          const service = yield* SessionService;
          yield* service.resumeRuns;
          const stepped = yield* sweptAmong([doomed.sessionId]);
          return {
            stepped,
            prUrl: yield* prUrlOf(doomed.sessionId),
            recorded: yield* recordedPr(doomed.sessionId),
            creates: createsFor(doomed.sessionId),
            tasks: yield* (yield* TaskService).exit(doomed.taskId),
          };
        }),
      );
      const second = await onBoot(
        root,
        true,
        Effect.gen(function* () {
          const service = yield* SessionService;
          yield* service.resumeRuns;
          const stepped = yield* sweptAmong([doomed.sessionId]);
          return { stepped, creates: createsFor(doomed.sessionId) };
        }),
      );

      // The kill left a settled run and no PR: the step died in its GitHub call.
      expect(signal).toBe("SIGKILL");
      expect(left).toEqual({ prUrl: null, recorded: undefined });
      // The next boot took the step it was owed, once, through the settle's own path.
      expect(first.stepped).toEqual([doomed.sessionId]);
      expect(decisionsOf(doomed.sessionId)).toEqual(["opened"]);
      expect(first.creates).toBe(1);
      expect(first.prUrl).toMatch(
        new RegExp(`/f16-${runId}/killed/pull/\\d+$`),
      );
      expect(first.recorded?.url).toBe(first.prUrl);
      expect(
        first.tasks.requirements.find((r) => r.key === "pr_link")?.status,
      ).toBe("met");
      // And the boot after it has nothing left to do for it.
      expect(second.stepped).toEqual([]);
      expect(second.creates).toBe(1);
      expect(decisionsOf(doomed.sessionId)).toEqual(["opened"]);
    },
    CASE,
  );

  /**
   * Mutation: drop the announcement check (`readSettleAnnouncement`) — every boot steps the even and
   * the over-cap sessions again, adding a no-change line, a not-opened line and a card note.
   * Mutation: compare the announcement with nothing (skip whenever there is one) — the even session
   * whose tip moved by hand is not stepped, and has no PR.
   */
  it(
    "a settle whose step already said no-change or not-opened is not announced again at boot; one whose tip moved since is stepped",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "factory-f16-announced-"));
      const live = await onBoot(
        root,
        true,
        Effect.gen(function* () {
          const even = yield* buildRun(yield* register(0, "even"));
          const over = yield* buildRun(yield* register(3, "over"));
          yield* settled(even.sessionId);
          yield* settled(over.sessionId);
          yield* decided(even.sessionId);
          yield* decided(over.sessionId);
          const service = yield* SessionService;
          return {
            even,
            over,
            worktree: (yield* service.get(even.sessionId)).workspace.path,
          };
        }),
      );
      const ids = [live.even.sessionId, live.over.sessionId];
      const again = await onBoot(
        root,
        true,
        Effect.gen(function* () {
          const service = yield* SessionService;
          const tasks = yield* TaskService;
          const stepped = yield* sweptAmong(ids);
          return {
            stepped,
            even: yield* service.get(live.even.sessionId),
            over: yield* service.get(live.over.sessionId),
            overThread: yield* tasks.comments(live.over.taskId),
          };
        }),
      );
      // A commit nobody's step has seen: the even branch has a change now.
      writeFileSync(join(live.worktree, "by-hand.txt"), "x\n");
      execSync(
        "git add by-hand.txt && git -c user.email=f16@localhost -c user.name=f16 commit -qm by-hand",
        { cwd: live.worktree, stdio: "ignore" },
      );
      const moved = await onBoot(
        root,
        true,
        Effect.gen(function* () {
          const stepped = yield* sweptAmong(ids);
          return {
            stepped,
            prUrl: yield* prUrlOf(live.even.sessionId),
            overUrl: yield* prUrlOf(live.over.sessionId),
          };
        }),
      );

      expect(decisionsOf(live.over.sessionId)).toEqual(["over-cap"]);
      // The second boot stepped neither, so each line and the card's note are there once.
      expect(again.stepped).toEqual([]);
      expect(said(again.even, "nothing to publish")).toHaveLength(1);
      expect(said(again.over, "over the cap")).toHaveLength(1);
      expect(again.overThread).toHaveLength(1);
      // The tip that moved is a settle nobody answered: stepped, and its PR opens.
      expect(moved.stepped).toEqual([live.even.sessionId]);
      expect(decisionsOf(live.even.sessionId)).toEqual(["no-change", "opened"]);
      expect(moved.prUrl).toMatch(/\/pull\/\d+$/);
      expect(createsFor(live.even.sessionId)).toBe(1);
      expect(moved.overUrl).toBeNull();
      expect(createsFor(live.over.sessionId)).toBe(0);
    },
    CASE,
  );

  /**
   * Mutation: drop the declaration check from the sweep (step every row the SQL finds) — the replay
   * and the parked run are stepped (a PR, or a note). Mutation: drop `forked_from IS NULL` — the fork
   * is stepped. Mutation: drop the task-run/trigger provenance from the query and the declaration —
   * the person's session gets a PR.
   */
  it(
    "leaves a person's session, a fork, a replay, a released workspace and a parked run untouched",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "factory-f16-untouched-"));
      // A process with no forge pair settles every run and steps none, as a death before every step.
      const made = await onBoot(
        root,
        false,
        Effect.gen(function* () {
          const service = yield* SessionService;
          const repo = yield* register(1, "fits");
          const person = yield* service.create({
            title: "a person's change",
            repo,
            baseRef: "main",
            actor: "person:f16",
          });
          yield* service.send({ sessionId: person.id, content: "change it" });
          const trigger = yield* service.create({
            title: "a trigger's change",
            repo,
            baseRef: "main",
            requestId: `trigger:f16-${runId}`,
            actor: "trigger:generic",
          });
          yield* service.send({ sessionId: trigger.id, content: "change it" });
          yield* settled(person.id);
          yield* settled(trigger.id);
          const fork = yield* service.fork({ sessionId: trigger.id });
          const replay = yield* service.replay({ sessionId: trigger.id });
          yield* settled(replay.id);
          const released = yield* buildRun(yield* register(1, "released"));
          yield* settled(released.sessionId);
          yield* service.releaseWorkspace({
            sessionId: released.sessionId,
            reason: "canceled",
          });
          const parked = yield* buildRun(yield* register(1, "parked"), true);
          yield* settled(parked.sessionId);
          return {
            trigger: trigger.id,
            untouched: [
              person.id,
              fork.id,
              replay.id,
              released.sessionId,
              parked.sessionId,
            ],
          };
        }),
      );
      const all = [made.trigger, ...made.untouched];
      const swept = await onBoot(
        root,
        true,
        Effect.gen(function* () {
          const service = yield* SessionService;
          const before = yield* Effect.forEach(made.untouched, (id) =>
            Effect.map(service.get(id), (read) => read.entries.length),
          );
          const stepped = yield* sweptAmong(all);
          const after = yield* Effect.forEach(made.untouched, (id) =>
            Effect.map(service.get(id), (read) => read.entries.length),
          );
          const urls = yield* Effect.forEach(made.untouched, prUrlOf);
          return {
            stepped,
            before,
            after,
            urls,
            trigger: yield* prUrlOf(made.trigger),
          };
        }),
      );

      // The trigger's own session owed its PR, and got it: the sweep ran, and this is what it skipped.
      expect(swept.stepped).toEqual([made.trigger]);
      expect(swept.trigger).toMatch(/\/pull\/\d+$/);
      expect(swept.after).toEqual(swept.before);
      expect(swept.urls).toEqual(made.untouched.map(() => null));
      for (const id of made.untouched) {
        expect(decisionsOf(id)).toEqual([]);
        expect(createsFor(id)).toBe(0);
      }
    },
    CASE,
  );
});
