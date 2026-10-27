// Seed one session whose log records a PR, for the client drives (LOB-65).
//
//   bun .pi/skills/lib/seed-pr.ts
//
// `verify-cli` and `verify-web` prove that a session's PR link reaches the operator — a column in
// `factory ls`, an anchor in the session pane's header. Neither can get a PR out of the API they
// drive: the PR step is `SessionService.openPullRequest`, and no RPC member calls it (its callers
// are the docs run and the board's start, both in-process). So this script is the in-process caller.
// It builds the real `SessionService` on the run's `DATABASE_URL` and `SESSION_ROOT`, creates a
// session bound to a repo, runs the real PR step against the loopback GitHub fake that
// `verify-api` already owns, reads the session back, and exits. The API the drive is talking to then
// reads the same row and the same log; nothing here is a second source of truth.
//
// The process must have exited before a client attaches: Pi Durable allows one owner per log, and
// this process owns the seeded one while the step runs. Exiting releases it, exactly as the idle
// sweep would.
//
// Nothing here reaches github.com: the fake answers on loopback, and the URL it hands back is a
// string the drives compare, never fetch.
//
// Env:
//   DATABASE_URL         the run's database (via DatabaseLive) — the same one the API uses
//   SESSION_ROOT         the API's session root, so the workspace the API resolves is this one
//   PR_SEED_OUT          where the answer is written as JSON (default .verify/run/pr-seed.json)
//   PR_SEED_GITHUB_PORT  the fake's port; 0 (the default) lets the OS pick a free one
//   PR_SEED_REPO         the repo the session binds to (default lobiklukas/pr-link-<run>) — a slug
//                        no checkout is registered for, so the session directory is a plain one and
//                        the step opens the PR rather than measuring someone else's branch. The run
//                        suffix makes every seeded link distinct: the fake numbers its PRs from 1,
//                        so a fixed slug would hand every run the same URL, and an anchor showing
//                        another session's link would still compare equal
//   PR_SEED_TITLE        the session's title (default "verify pr link probe")
import { BunServices } from "@effect/platform-bun";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect, Layer, ManagedRuntime, Option, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { RepoSlug as RepoSlugSchema } from "@repo/domain/Session";
import { createModelAccess } from "@repo/harness";
import { DatabaseLive } from "@repo/storage-postgres";
import {
  CredentialProvider,
  SessionService,
  SessionServiceLive,
  staticTokenProvider,
} from "@repo/core";

const ROOT = path.resolve(import.meta.dir, "../../..");

const OUT =
  process.env["PR_SEED_OUT"] ?? path.join(ROOT, ".verify/run/pr-seed.json");
const SESSION_ROOT =
  process.env["SESSION_ROOT"] ?? path.join(ROOT, ".verify/run/sessions");
const PORT = process.env["PR_SEED_GITHUB_PORT"] ?? "0";
const REPO = RepoSlugSchema.make(
  process.env["PR_SEED_REPO"] ??
    `lobiklukas/pr-link-${Date.now().toString(36)}${process.pid}`,
);
const TITLE = process.env["PR_SEED_TITLE"] ?? "verify pr link probe";
const FAKE = path.join(ROOT, ".pi/skills/verify-api/github-fake.ts");
const LEDGER = path.join(path.dirname(OUT), "pr-seed-github-ledger.json");

await mkdir(path.dirname(OUT), { recursive: true });

// --- the fake --------------------------------------------------------------------------------------
const fake = Bun.spawn(["bun", FAKE], {
  env: {
    ...process.env,
    GITHUB_FAKE_PORT: PORT,
    GITHUB_FAKE_LEDGER: LEDGER,
  },
  stdout: "pipe",
  stderr: "inherit",
});

/** The fake's own announcement, which carries the port it really bound (0 means "the OS chose"). */
const listening = async (): Promise<string> => {
  const decoder = new TextDecoder();
  let seen = "";
  for await (const chunk of fake.stdout) {
    seen += decoder.decode(chunk);
    const match = /github-fake listening on (\S+)/.exec(seen);
    // `server.url` ends in a slash; the PR client appends `/repos/...`, and a doubled slash is a
    // path the fake does not route.
    if (match?.[1] !== undefined) return match[1].replace(/\/+$/, "");
  }
  throw new Error(`the GitHub fake exited before listening: ${seen}`);
};

let failed = false;
const fail = (message: string): void => {
  failed = true;
  console.error(`seed-pr: ${message}`);
};

try {
  const githubUrl = await Promise.race([
    listening(),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("the GitHub fake never listened")),
        10_000,
      ),
    ),
  ]);
  // Read per call by the PR client (`githubApiUrl`), so setting it here points this process at the
  // fake and at nothing else.
  process.env["GITHUB_API_URL"] = githubUrl;

  const runtime = ManagedRuntime.make(
    SessionServiceLive({
      model: createModelAccess("faux"),
      sessionRoot: SESSION_ROOT,
    }).pipe(
      Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)),
    ),
  );
  const github = Layer.merge(
    Layer.succeed(
      CredentialProvider,
      staticTokenProvider(Option.some(Redacted.make("pr-seed-fake-token"))),
    ),
    FetchHttpClient.layer,
  );

  try {
    const seeded = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const created = yield* sessions.create({
          repo: REPO,
          baseRef: "main",
          title: TITLE,
        });
        const opened = yield* sessions
          .openPullRequest({
            sessionId: created.id,
            title: TITLE,
            head: `factory/${created.id}`,
            base: "main",
          })
          .pipe(Effect.provide(github));
        // The link the drives compare against is the one the session *recorded*, read back the way
        // a client reads it, not the one the fake answered.
        const after = yield* sessions.get(created.id);
        return { sessionId: created.id, opened, prUrl: after.session.prUrl };
      }),
    );
    if (seeded.opened.outcome !== "opened") {
      fail(`the PR step answered ${seeded.opened.outcome}, not opened`);
    } else if (seeded.prUrl !== seeded.opened.url) {
      fail(
        `the session recorded ${String(seeded.prUrl)}, the step answered ${seeded.opened.url}`,
      );
    }
    const answer = {
      sessionId: seeded.sessionId,
      prUrl: seeded.prUrl ?? null,
      repo: REPO,
      title: TITLE,
      githubUrl,
    };
    await writeFile(OUT, `${JSON.stringify(answer, null, 2)}\n`);
    console.log(`seed-pr: ${JSON.stringify(answer)}`);
  } finally {
    // Releases the seeded log's owner before any client attaches to it.
    await runtime.dispose();
  }
} catch (error) {
  fail(String(error));
  // The whole value, not only its message: a failed connect names the database it could not open
  // in its cause, and that is the line a person needs.
  console.error(error);
} finally {
  fake.kill();
  await fake.exited;
}

process.exit(failed ? 1 : 0);
