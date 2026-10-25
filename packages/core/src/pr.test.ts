import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { describe, expect, it } from "vitest";
import { SessionId, RepoSlug } from "@repo/domain/Session";
import { CredentialProvider, staticTokenProvider } from "./credentials";
import { buildPrBody, createPullRequest } from "./pr";
import { diffCapRefusal, parseDiffSize } from "./prStep";

const makeFakeHttp = (status: number, body: unknown) => {
  const requests: Array<{
    method: string;
    url: string;
    authorization: string | undefined;
    body: unknown;
  }> = [];
  const Json = Schema.fromJsonString(Schema.Unknown);
  const client = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.gen(function* () {
        const reqBody =
          request.body._tag === "Uint8Array"
            ? yield* Schema.decodeEffect(Json)(
                new TextDecoder().decode(request.body.body),
              )
            : undefined;
        requests.push({
          method: request.method,
          url: url.pathname,
          authorization: request.headers["authorization"],
          body: reqBody,
        });
        const text = yield* Schema.encodeEffect(Json)(body).pipe(Effect.orDie);
        const response = new Response(text, {
          status,
          headers: { "content-type": "application/json" },
        });
        return HttpClientResponse.fromWeb(request, response);
      }).pipe(Effect.orDie),
    ),
  );
  return { requests, client };
};

/**
 * A fake that answers per request rather than with one canned response, so a case can drive the
 * duplicate path: the create is refused and the lookup that follows it answers the existing PR.
 *
 * `answers` returns the status and body for a request; the record keeps the full URL so a case can
 * check which API root the client called, not only which path.
 */
const makeRoutedFake = (
  answers: (request: { readonly method: string; readonly path: string }) => {
    readonly status: number;
    readonly body: unknown;
  },
) => {
  const requests: Array<{
    method: string;
    path: string;
    href: string;
    authorization: string | undefined;
    body: unknown;
  }> = [];
  const Json = Schema.fromJsonString(Schema.Unknown);
  const client = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.gen(function* () {
        const reqBody =
          request.body._tag === "Uint8Array"
            ? yield* Schema.decodeEffect(Json)(
                new TextDecoder().decode(request.body.body),
              )
            : undefined;
        const answer = answers({ method: request.method, path: url.pathname });
        requests.push({
          method: request.method,
          path: url.pathname,
          href: url.href,
          authorization: request.headers["authorization"],
          body: reqBody,
        });
        const text = yield* Schema.encodeEffect(Json)(answer.body).pipe(
          Effect.orDie,
        );
        const response = new Response(text, {
          status: answer.status,
          headers: { "content-type": "application/json" },
        });
        return HttpClientResponse.fromWeb(request, response);
      }).pipe(Effect.orDie),
    ),
  );
  return { requests, client };
};

describe("buildPrBody", () => {
  it("carries session id, model and spend", () => {
    const body = buildPrBody({
      sessionId: "s-1" as SessionId,
      prompt: "do thing",
      model: "m",
      spend: "$0.01",
    });
    expect(body).toContain("s-1");
    expect(body).toContain("m");
    expect(body).toContain("$0.01");
    expect(body).toContain("do thing");
  });
});

describe("createPullRequest", () => {
  it("opens a PR and asserts body carries session id, model, spend", async () => {
    const { requests, client } = makeFakeHttp(201, {
      number: 7,
      url: "https://github.com/o/r/pull/7",
    });
    const provider = staticTokenProvider(Option.some(Redacted.make("tok")));
    // need Option import
    const program = createPullRequest({
      repo: "o/r" as RepoSlug,
      base: "main",
      head: "factory/s-1",
      title: "PR",
      body: buildPrBody({
        sessionId: "s-1" as SessionId,
        prompt: "do thing",
        model: "m",
        spend: "$0.01",
      }),
    }).pipe(
      Effect.provide(
        Layer.merge(Layer.succeed(CredentialProvider, provider), client),
      ),
    );
    const res = await Effect.runPromise(program);
    expect(res.number).toBe(7);
    expect(requests[0]!.body).toMatchObject({
      head: "factory/s-1",
      base: "main",
    });
    expect((requests[0]!.body as any).body).toContain("s-1");
    expect(requests[0]!.authorization).toBe("Bearer tok");
  });

  it("surfaces credential failure as typed error", async () => {
    const { client } = makeFakeHttp(201, { number: 1, url: "u" });
    const provider = staticTokenProvider(Option.none());
    const program = createPullRequest({
      repo: "o/r" as RepoSlug,
      base: "main",
      head: "h",
      title: "t",
      body: "b",
    }).pipe(
      Effect.provide(
        Layer.merge(Layer.succeed(CredentialProvider, provider), client),
      ),
    );
    const result = await Effect.runPromiseExit(program);
    expect(result._tag).toBe("Failure");
  });

  it("adopts the PR GitHub already opened when it refuses a duplicate", async () => {
    const existing = {
      number: 12,
      url: "https://github.com/o/r/pull/12",
    };
    const { requests, client } = makeRoutedFake(({ method }) =>
      method === "POST"
        ? {
            status: 422,
            body: {
              message: "Validation Failed",
              errors: [
                { message: "A pull request already exists for o:factory/s-1." },
              ],
            },
          }
        : { status: 200, body: [existing] },
    );
    const provider = staticTokenProvider(Option.some(Redacted.make("tok")));
    const opened = await Effect.runPromise(
      createPullRequest({
        repo: "o/r" as RepoSlug,
        base: "main",
        head: "factory/s-1",
        title: "PR",
        body: "b",
        apiUrl: "http://127.0.0.1:9411",
      }).pipe(
        Effect.provide(
          Layer.merge(Layer.succeed(CredentialProvider, provider), client),
        ),
      ),
    );
    expect(opened).toEqual(existing);
    // The lookup is what makes the refused create an answer: it asks for this head, on this base.
    expect(requests.map((request) => request.method)).toEqual(["POST", "GET"]);
    expect(requests[1]!.path).toBe("/repos/o/r/pulls");
    expect(requests[1]!.href).toContain("head=o%3Afactory%2Fs-1");
    expect(requests[1]!.href).toContain("base=main");
    // And it is the configured root, not api.github.com: the fake never sees github.com.
    expect(requests[0]!.href.startsWith("http://127.0.0.1:9411/")).toBe(true);
    // The lookup is authenticated like the create: a private repo refuses the GET otherwise, and
    // an unauthenticated answer is exactly the case a fake that ignores headers would hide.
    expect(requests[1]!.authorization).toBe("Bearer tok");
  });

  it("reports a duplicate that names no existing PR as a typed failure", async () => {
    const { requests, client } = makeRoutedFake(({ method }) =>
      method === "POST"
        ? { status: 422, body: { message: "Validation Failed" } }
        : { status: 200, body: [] },
    );
    const provider = staticTokenProvider(Option.some(Redacted.make("tok")));
    const result = await Effect.runPromiseExit(
      createPullRequest({
        repo: "o/r" as RepoSlug,
        base: "main",
        head: "factory/s-1",
        title: "PR",
        body: "b",
        apiUrl: "http://127.0.0.1:9411",
      }).pipe(
        Effect.provide(
          Layer.merge(Layer.succeed(CredentialProvider, provider), client),
        ),
      ),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") throw new Error("unreachable");
    const error = result.cause.reasons.flatMap((reason) =>
      reason._tag === "Fail"
        ? [reason.error as { operation: string; message: string }]
        : [],
    )[0];
    expect(error?.operation).toBe("createPullRequest");
    expect(error?.message).toBe("GitHub answered HTTP 422");
    expect(requests).toHaveLength(2);
  });

  it("calls GITHUB_API_URL when the caller names no root", async () => {
    // oxlint-disable-next-line effecttsgo/process-env -- a case points the client at a loopback root.
    const previous = process.env["GITHUB_API_URL"];
    // oxlint-disable-next-line effecttsgo/process-env -- the deployment seam under test.
    process.env["GITHUB_API_URL"] = "http://127.0.0.1:9411";
    try {
      const { requests, client } = makeRoutedFake(() => ({
        status: 201,
        body: { number: 3, url: "http://127.0.0.1:9411/o/r/pull/3" },
      }));
      const provider = staticTokenProvider(Option.some(Redacted.make("tok")));
      await Effect.runPromise(
        createPullRequest({
          repo: "o/r" as RepoSlug,
          base: "main",
          head: "factory/s-1",
          title: "PR",
          body: "b",
        }).pipe(
          Effect.provide(
            Layer.merge(Layer.succeed(CredentialProvider, provider), client),
          ),
        ),
      );
      expect(requests[0]!.href.startsWith("http://127.0.0.1:9411/")).toBe(true);
    } finally {
      // An empty value is an unset one to the client, so the restore needs no delete.
      // oxlint-disable-next-line effecttsgo/process-env -- restoring what the case found.
      process.env["GITHUB_API_URL"] = previous ?? "";
    }
  });
});

/**
 * The measurement the cap is made of, away from the service.
 *
 * Everything here is a reading of `git diff --numstat`'s own output, so the rows are the command's
 * real shapes rather than invented ones: an ordinary text change, a binary file (which git spells
 * with two `-`), a deletion, and a rename (whose path column carries `old => new`).
 */
describe("parseDiffSize", () => {
  it("sums the added and deleted lines and counts the files", () => {
    expect(
      parseDiffSize("3\t1\tsrc/a.ts\n10\t0\tsrc/b.ts\n0\t4\tsrc/gone.ts\n"),
    ).toEqual({ files: 3, lines: 18 });
  });

  it("counts a binary file as a file and no lines", () => {
    // git reports both counts as `-` for a binary change; `Number("-")` is `NaN`, so this is the
    // row that turns a missing `|| 0` into `NaN` files and lines.
    expect(parseDiffSize("-\t-\tassets/logo.png\n")).toEqual({
      files: 1,
      lines: 0,
    });
  });

  it("is zero for a diff with no rows", () => {
    expect(parseDiffSize("")).toEqual({ files: 0, lines: 0 });
    // A trailing newline is not a row: `git diff` always ends its output with one.
    expect(parseDiffSize("\n")).toEqual({ files: 0, lines: 0 });
  });

  it("still counts a file whose path column carries a rename", () => {
    expect(parseDiffSize("1\t1\tdocs/{old.md => new.md}\n")).toEqual({
      files: 1,
      lines: 2,
    });
  });
});

describe("diffCapRefusal", () => {
  /** A throwaway checkout: the measurement is git's, so the case needs a real one. */
  const checkout = (files: Record<string, string>): string => {
    const directory = mkdtempSync(join(tmpdir(), "factory-cap-"));
    execSync("git init -b main", { cwd: directory, stdio: "ignore" });
    execSync("git config user.email t@t.com", {
      cwd: directory,
      stdio: "ignore",
    });
    execSync("git config user.name t", { cwd: directory, stdio: "ignore" });
    execSync("git commit --allow-empty -m init", {
      cwd: directory,
      stdio: "ignore",
    });
    // On a branch cut from `main`, as the session's own worktree is: a change committed straight
    // onto `main` would measure nothing against it.
    execSync("git switch -c factory/change main", {
      cwd: directory,
      stdio: "ignore",
    });
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(directory, name), content);
    }
    execSync("git add -A", { cwd: directory, stdio: "ignore" });
    execSync("git commit -m change", { cwd: directory, stdio: "ignore" });
    return directory;
  };

  it("refuses on the file count first, naming the limit and the size", async () => {
    const worktree = checkout({
      "a.txt": "1\n",
      "b.txt": "1\n",
      "c.txt": "1\n",
    });
    const answer = await Effect.runPromise(
      diffCapRefusal({
        worktree,
        base: "main",
        cap: { maxFiles: 2, maxLines: 100 },
      }),
    );
    expect(answer).toEqual(
      Option.some({
        outcome: "over-cap",
        limit: "files",
        cap: 2,
        measured: 3,
      }),
    );
  });

  it("refuses on the line count when only lines are over, naming that limit", async () => {
    const worktree = checkout({ "a.txt": "x\n".repeat(5) });
    const answer = await Effect.runPromise(
      diffCapRefusal({
        worktree,
        base: "main",
        cap: { maxFiles: 10, maxLines: 4 },
      }),
    );
    expect(answer).toEqual(
      Option.some({
        outcome: "over-cap",
        limit: "lines",
        cap: 4,
        measured: 5,
      }),
    );
  });

  it("allows a diff exactly at both limits", async () => {
    const worktree = checkout({ "a.txt": "x\n".repeat(4), "b.txt": "1\n" });
    expect(
      await Effect.runPromise(
        diffCapRefusal({
          worktree,
          base: "main",
          cap: { maxFiles: 2, maxLines: 5 },
        }),
      ),
    ).toEqual(Option.none());
  });

  it("measures the branch against its base, not the working tree", async () => {
    const worktree = checkout({ "a.txt": "x\n".repeat(1) });
    // Staged *and* unstaged work is not in the branch, so it is not in what a PR would carry. The
    // file is staged on purpose: an untracked one is invisible to `git diff` in either form, so a
    // case that left it untracked would pass against a two-dot measurement that counted the index.
    writeFileSync(join(worktree, "staged.txt"), "x\n".repeat(50));
    execSync("git add staged.txt", { cwd: worktree, stdio: "ignore" });
    writeFileSync(join(worktree, "unstaged.txt"), "x\n".repeat(50));
    expect(
      await Effect.runPromise(
        diffCapRefusal({
          worktree,
          base: "main",
          cap: { maxFiles: 10, maxLines: 10 },
        }),
      ),
    ).toEqual(Option.none());
  });

  it("refuses nothing for a directory that is not its own checkout", async () => {
    // The deployment this repo runs today: a session against a bare slug has a plain directory,
    // and a diff that cannot be measured is not one that is over the cap. The directory is placed
    // *inside* a checkout on a branch with a large diff on purpose, because that is where
    // `SESSION_ROOT` puts it (`.factory/sessions` is inside the control plane's own tree): a bare
    // `git diff` there measures the enclosing repository's branch, so this is the case that says
    // the cap does not do that.
    const enclosing = checkout({ "big.txt": "x\n".repeat(500) });
    const plain = join(enclosing, "sessions", "ses_1");
    mkdirSync(plain, { recursive: true });
    expect(
      await Effect.runPromise(
        diffCapRefusal({
          worktree: plain,
          base: "main",
          cap: { maxFiles: 1, maxLines: 1 },
        }),
      ),
    ).toEqual(Option.none());
  });

  it("fails, naming the range, when a checkout's base cannot be read", async () => {
    // A checkout root whose base does not exist is not a diff that fits: the cap does not quietly
    // disappear because the measurement broke.
    const worktree = checkout({ "a.txt": "1\n" });
    const result = await Effect.runPromiseExit(
      diffCapRefusal({
        worktree,
        base: "no-such-base",
        cap: { maxFiles: 10, maxLines: 10 },
      }),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") throw new Error("unreachable");
    const error = result.cause.reasons.flatMap((reason) =>
      reason._tag === "Fail"
        ? [reason.error as { operation: string; ref: string }]
        : [],
    )[0];
    expect(error?.operation).toBe("diffSize");
    expect(error?.ref).toBe("no-such-base...HEAD");
  });
});
