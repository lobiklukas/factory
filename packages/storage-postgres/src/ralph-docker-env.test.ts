import { spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The ralph driver must not rewrite a `DOCKER_HOST` its caller set (LOB-105).
 *
 * `.pi/ralph/loop.sh`'s `docker_env` falls back to colima's socket when the active context does not
 * answer, and used to do so unconditionally: an explicit `DOCKER_HOST` was replaced whenever
 * `docker info` failed. That is the one thing the verify-* skills' shared helper promises not to do
 * (`.pi/skills/lib/postgres.sh`'s `pg_docker`, and `postgres-up.test.ts`'s
 * `never second-guesses an explicit DOCKER_HOST`), and the driver is the one that decides what every
 * session sees: `cmd_run` calls `ensure_db`, so the rewritten value is the `DOCKER_HOST` `session`
 * hands to each `pi -p` iteration, and the skills an agent then runs talk to colima while the caller
 * chose another socket.
 *
 * These cases drive the driver's own `docker_env` — the file is sourced, which is why its dispatch
 * sits behind `[ "${BASH_SOURCE[0]}" = "$0" ]` — against a fake `docker` first on `PATH`, per
 * `docs/testing-third-parties.md`. `$HOME` points at a scratch directory, and "colima is running"
 * is a real unix socket there, so the `-S` test is exercised rather than assumed. No case starts,
 * stops or contacts a container, and no case reads the machine's real `$HOME`: an unset
 * `DOCKER_HOST` in a case is a `DOCKER_HOST` this file deleted from the child's environment.
 *
 * The file lives in `@repo/storage-postgres` for the same reason `turbo-env.test.ts` and
 * `postgres-up.test.ts` do: it is a repo-level shell claim that belongs to no package, and it needs
 * no database to run. It carries its own fake `docker` rather than borrowing `postgres-up.test.ts`'s
 * — that harness is bound to `ensure_postgres` and its ports, and this one needs a scratch `$HOME`
 * with a socket in it.
 *
 * Each case below names the mutation it was checked against — the one edit that makes it go red. A
 * case whose mutation nobody can state is not testing anything.
 *
 * Two further rules keep those mutations honest. First, the value alone cannot distinguish "the
 * guard left it alone" from "docker was never consulted, or the fake was not what ran", so every
 * case that runs `docker_env` also asserts what the fake recorded — that `docker info` ran with
 * this argv and this `DOCKER_HOST`, or that it did not run at all. Second, the fake is only
 * authoritative while `docker` resolves to it: the last case holds the file to that, statically and
 * at run time.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const LOOP = path.join(REPO_ROOT, ".pi/ralph/loop.sh");
const LIB = path.join(REPO_ROOT, ".pi/skills/lib/postgres.sh");

/** Where the colima fallback looks, relative to `$HOME`. */
const COLIMA_SOCKET = ".colima/default/docker.sock";

const EXPLICIT = "unix:///var/run/docker.sock";

/** What the fake records for a variable the child's environment does not have. */
const UNSET = "<unset>";

interface Scratch {
  readonly root: string;
  /** `$HOME` of every child: short, because a unix socket path is capped at 104 bytes. */
  readonly home: string;
  readonly bin: string;
  readonly calls: string;
}

const created: string[] = [];
const listeners: Server[] = [];
afterAll(async () => {
  for (const listener of listeners) listener.close();
  for (const root of created) rmSync(root, { recursive: true, force: true });
});

const mkScratch = (): Scratch => {
  const root = mkdtempSync(path.join(tmpdir(), "factory-ralph-docker-env-"));
  const home = mkdtempSync(path.join("/tmp", "ralph-denv-"));
  created.push(root, home);
  const bin = path.join(root, "bin");
  mkdirSync(bin, { recursive: true });
  return { root, home, bin, calls: path.join(root, "docker-calls.txt") };
};

/**
 * A `docker` that records the argv, the directory and the `DOCKER_HOST` of every call, and answers
 * `info` with the code the case chose. Everything else succeeds, so `ensure_db` reaches its
 * `createdb` line against the fake and never touches a database.
 *
 * The record is a file, not stdout: `docker_env` redirects `docker info` to `/dev/null`, so a stub
 * that printed would record nothing. The directory is recorded for the same reason the skills'
 * fake does: compose names its project after the directory it runs from.
 */
const writeFakeDocker = (scratch: Scratch, infoExit: number): void => {
  const file = path.join(scratch.bin, "docker");
  writeFileSync(
    file,
    [
      "#!/usr/bin/env bash",
      `printf 'argv=%s\\tcwd=%s\\tdocker_host=%s\\n' "$*" "$PWD" "\${DOCKER_HOST-${UNSET}}" >> ${JSON.stringify(scratch.calls)}`,
      'case "$*" in',
      `  info) exit ${String(infoExit)} ;;`,
      "  *) exit 0 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(file, 0o755);
};

/** A real unix socket where the fallback looks: "colima is running" without a container runtime. */
const colimaIsRunning = async (scratch: Scratch): Promise<Server> => {
  const socketPath = path.join(scratch.home, COLIMA_SOCKET);
  mkdirSync(path.dirname(socketPath), { recursive: true });
  // A unix socket path is capped at 104 bytes; past it `listen` fails with `ENAMETOOLONG` and a
  // case below would die for a reason that has nothing to do with `docker_env`. The scratch `$HOME`
  // is deliberately short so the cap is never near: this keeps it that way. Harness invariant, not a
  // claim about `loop.sh` — its mutation is lengthening the prefix in `mkScratch`.
  expect(Buffer.byteLength(socketPath)).toBeLessThan(104);
  const listener = createServer();
  listener.listen(socketPath);
  await once(listener, "listening");
  listeners.push(listener);
  return listener;
};

/**
 * The environment of a child. The parent's `DOCKER_HOST` is deleted on purpose — this repo's own
 * ralph driver exports one — so a case that wants it unset gets it unset, and only `extra` decides
 * what the case is about. Same `Object.entries` read as `turbo-env.test.ts`: a direct
 * `process.env.NAME` is configuration, and a test inheriting a shell's value is not configuring.
 *
 * The fake has to exist before a child runs: a case that forgot `writeFakeDocker` would drive the
 * machine's real CLI, whose answer depends on the machine — and the cases whose claim is "nothing
 * changed" or "docker was never called" could pass on it. This asserts the premise every case
 * rests on instead of letting a harness slip read as a green.
 */
const childEnv = (
  scratch: Scratch,
  extra: Record<string, string>,
): Record<string, string> => {
  expect(
    readdirSync(scratch.bin),
    "writeFakeDocker must run before the child does",
  ).toContain("docker");
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const env: Record<string, string> = {
    ...inherited,
    PATH: `${scratch.bin}${path.delimiter}${inherited["PATH"] ?? ""}`,
    HOME: scratch.home,
    LOOP,
    LIB,
  };
  delete env["DOCKER_HOST"];
  return { ...env, ...extra };
};

interface BashRun {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run a body in bash with the fake `docker` on `PATH`, and hand back everything it did. */
const bashResult = (
  scratch: Scratch,
  body: string,
  extra: Record<string, string> = {},
): BashRun => {
  const run = spawnSync("bash", ["-c", body], {
    cwd: scratch.root,
    encoding: "utf8",
    env: childEnv(scratch, extra),
    timeout: 30_000,
  });
  return {
    status: run.status ?? -1,
    stdout: run.stdout,
    stderr: run.stderr,
  };
};

/** The same, for a case that expects the body to succeed. */
const bash = (
  scratch: Scratch,
  body: string,
  extra: Record<string, string> = {},
): string => {
  const run = bashResult(scratch, body, extra);
  if (run.status !== 0) {
    throw new Error(
      `bash exited ${String(run.status)}: ${run.stderr}\n${run.stdout}`,
    );
  }
  return run.stdout;
};

/**
 * What `docker_env` left in the environment after sourcing the driver. `<unset>` and an empty string
 * are different answers on purpose: `loop.sh` unsets the variable before it hands it to a session,
 * so "exported as empty" would still be a rewrite.
 */
const afterDockerEnv = (
  scratch: Scratch,
  extra: Record<string, string> = {},
): string =>
  bash(
    scratch,
    'source "$LOOP"; docker_env; printf "%s" "${DOCKER_HOST-<unset>}"',
    extra,
  );

interface DockerCall {
  readonly argv: string;
  readonly cwd: string;
  readonly dockerHost: string;
}

/** Every call the fake saw, in order — the proof that it, and not the real CLI, was consulted. */
const dockerRecords = (scratch: Scratch): DockerCall[] => {
  try {
    return readFileSync(scratch.calls, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => {
        const [argv, cwd, dockerHost] = line.split("\t");
        return {
          argv: (argv ?? "").slice("argv=".length),
          cwd: (cwd ?? "").slice("cwd=".length),
          dockerHost: (dockerHost ?? "").slice("docker_host=".length),
        };
      });
  } catch {
    return [];
  }
};

/** The same calls, narrowed to what the `docker_env` cases assert. */
const dockerCalls = (
  scratch: Scratch,
): ReadonlyArray<Pick<DockerCall, "argv" | "dockerHost">> =>
  dockerRecords(scratch).map(({ argv, dockerHost }) => ({ argv, dockerHost }));

/**
 * The checkout `ensure_db` exports into: `MAIN_ROOT`, the parent of the repository's common git
 * directory. Derived the way `loop.sh` derives it, because in a ralph worktree it is the main
 * checkout and not the directory this suite runs from.
 */
const mainRoot = (): string => {
  const run = spawnSync(
    "git",
    [
      "-C",
      REPO_ROOT,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ],
    { encoding: "utf8" },
  );
  const common = run.stdout.trim();
  expect(common, `git rev-parse --git-common-dir: ${run.stderr}`).not.toBe("");
  return path.dirname(common);
};

/** The colima socket `docker_env` should have exported for this scratch `$HOME`. */
const colimaSocket = (scratch: Scratch): string =>
  `unix://${path.join(scratch.home, COLIMA_SOCKET)}`;

describe("the ralph driver's docker_env", () => {
  it("leaves an explicit DOCKER_HOST alone, and never probes either way", async () => {
    // The acceptance criterion: with the caller's socket set and `docker info` failing, the value is
    // unchanged — this driver used to replace it with colima's here, and the skills an agent then
    // ran disagreed with the caller about which daemon was authoritative. The guard's first clause
    // short-circuits, so with the fix the probe does not run at all and the fake's answer cannot be
    // what saved the value: which is why both exit codes are driven and why the no-call assertion,
    // not the value, is what makes the short-circuit observable. Mutation: delete
    // `[ -z "${DOCKER_HOST:-}" ] &&` — an `info` call appears, and the `infoExit: 1` half also gets
    // colima's socket back.
    //
    // A child that did not resolve the fake is invisible *here*: with an explicit socket no docker
    // runs at all, so the value and the empty record agree that nothing happened. That premise is
    // asserted where it can be seen — `childEnv` refuses to build an environment without the fake,
    // and the last case in this file proves `command -v docker` resolves it in this very
    // environment.
    for (const infoExit of [1, 0]) {
      const scratch = mkScratch();
      await colimaIsRunning(scratch);
      writeFakeDocker(scratch, infoExit);
      const label = `docker info exits ${String(infoExit)}`;

      expect(afterDockerEnv(scratch, { DOCKER_HOST: EXPLICIT }), label).toBe(
        EXPLICIT,
      );
      expect(dockerCalls(scratch), label).toEqual([]);
    }
  });

  it("falls back to colima's socket when nothing else answers", async () => {
    // Mutation: `[ -z "${DOCKER_HOST:-}" ]` → `[ -n "${DOCKER_HOST:-}" ]`, and an unset host no
    // longer falls back at all. Deleting the `:-` instead leaves `${DOCKER_HOST}` unbound under the
    // `set -u` the sourced file sets, which fails the same case.
    const scratch = mkScratch();
    await colimaIsRunning(scratch);
    writeFakeDocker(scratch, 1);

    expect(afterDockerEnv(scratch)).toBe(colimaSocket(scratch));
    // And it probed with no `DOCKER_HOST` at all: the child's environment really is the unset one
    // this case claims, not a value inherited from the shell running the suite.
    expect(dockerCalls(scratch)).toEqual([{ argv: "info", dockerHost: UNSET }]);
  });

  it("treats an empty DOCKER_HOST as unset, the way the skills' helper reads it", async () => {
    // `pg_docker` and `docker_env` both spell the guard `${DOCKER_HOST:-}`, so an empty value falls
    // back (`postgres-up.test.ts` passes `DOCKER_HOST: ""` to reach its colima case for exactly this
    // reason). Mutations: `-z` → `-n` — an empty host would then stop falling back and the driver
    // would export an empty string instead; or a guard spelled as an arity test
    // (`[ "${DOCKER_HOST+x}" ]`, i.e. "the variable exists"), which stops falling back for an empty
    // value a caller exported and the two helpers disagreed about.
    const scratch = mkScratch();
    await colimaIsRunning(scratch);
    writeFakeDocker(scratch, 1);

    expect(afterDockerEnv(scratch, { DOCKER_HOST: "" })).toBe(
      colimaSocket(scratch),
    );
    // An empty string is set, so the fake records it as empty rather than as `<unset>`.
    expect(dockerCalls(scratch)).toEqual([{ argv: "info", dockerHost: "" }]);
  });

  it("exports nothing when the active context answers", async () => {
    // Mutation: delete `! docker info >/dev/null 2>&1 &&`, so a reachable docker still triggers the
    // fallback.
    const scratch = mkScratch();
    await colimaIsRunning(scratch);
    writeFakeDocker(scratch, 0);

    expect(afterDockerEnv(scratch)).toBe(UNSET);
    expect(dockerCalls(scratch)).toEqual([{ argv: "info", dockerHost: UNSET }]);
  });

  it("exports nothing when there is no colima socket to fall back to", async () => {
    // Mutation: delete `&& [ -S "$HOME/.colima/default/docker.sock" ]`, and the fallback points at a
    // socket that does not exist — which is worse than the unset value it replaced.
    const scratch = mkScratch();
    writeFakeDocker(scratch, 1);

    expect(afterDockerEnv(scratch)).toBe(UNSET);
    expect(dockerCalls(scratch)).toEqual([{ argv: "info", dockerHost: UNSET }]);
  });

  it("does not mistake a plain file for colima's socket", async () => {
    // A stale `docker.sock` left behind by a colima that was uninstalled is a regular file. `-S`
    // asks whether a socket accepts there; `-e` asks whether a name exists. Mutation: `-S` → `-e`,
    // and the driver points every session at a dead socket — the failure the type test exists to
    // prevent, and a worse one than the unset value it replaced.
    const scratch = mkScratch();
    writeFakeDocker(scratch, 1);
    const socketPath = path.join(scratch.home, COLIMA_SOCKET);
    mkdirSync(path.dirname(socketPath), { recursive: true });
    writeFileSync(socketPath, "");

    expect(afterDockerEnv(scratch)).toBe(UNSET);
    expect(dockerCalls(scratch)).toEqual([{ argv: "info", dockerHost: UNSET }]);
  });

  it("probes once across two calls, and writes nothing outside the environment", async () => {
    // `ensure_db` calls `docker_env` on every `cmd_run`/`cmd_merge`/`cmd_plan`, and a stale export
    // from an earlier call must not cost a second probe — the same "resolved once, then kept"
    // `pg_docker` case in `postgres-up.test.ts` asserts. Mutations: (a) delete
    // `[ -z "${DOCKER_HOST:-}" ] &&` — the second call probes again (two records) and rewrites a
    // value it no longer owns; (b) a `docker_env` that leaves something behind rather than only
    // exporting — a state file in the caller's directory, or any new entry in `$HOME` beside the
    // colima directory this case made.
    const scratch = mkScratch();
    await colimaIsRunning(scratch);
    writeFakeDocker(scratch, 1);

    const out = bash(
      scratch,
      [
        'source "$LOOP"',
        "docker_env",
        'first="${DOCKER_HOST-<unset>}"',
        "docker_env",
        'printf "first=%s\\nsecond=%s\\n" "$first" "${DOCKER_HOST-<unset>}"',
      ].join("\n"),
    );

    expect(out).toBe(
      `first=${colimaSocket(scratch)}\nsecond=${colimaSocket(scratch)}\n`,
    );
    expect(dockerCalls(scratch)).toEqual([{ argv: "info", dockerHost: UNSET }]);
    // Nothing was written for it: the only things in the scratch root are this case's own, and the
    // `$HOME` the driver looked in holds the colima directory this case made and nothing else.
    expect(readdirSync(scratch.root).sort()).toEqual([
      "bin",
      "docker-calls.txt",
    ]);
    expect(readdirSync(scratch.home)).toEqual([".colima"]);
  });

  it("agrees with the skills' helper about an explicit socket", async () => {
    // Mutation: delete `[ -z "${DOCKER_HOST:-}" ] &&` from the driver's guard: the loop half of this
    // case then reports colima while `pg_docker` keeps the explicit value — the disagreement the
    // issue exists to remove, and the one an agent's own drive would act on.
    const scratch = mkScratch();
    await colimaIsRunning(scratch);
    writeFakeDocker(scratch, 1);

    const out = bash(
      scratch,
      [
        'source "$LOOP"; source "$LIB"',
        "docker_env",
        'printf "loop=%s\\n" "${DOCKER_HOST-<unset>}"',
        // The fake's `info` branch exits 1 — a stopped context is the case — and the sourced file
        // sets `-e`, so the failure is tolerated here and asserted on the value instead.
        "pg_docker info || true",
        'printf "skills=%s\\n" "${DOCKER_HOST-<unset>}"',
      ].join("\n"),
      { DOCKER_HOST: EXPLICIT },
    );

    expect(out).toBe(`loop=${EXPLICIT}\nskills=${EXPLICIT}\n`);
    // Two helpers, one socket, and neither of them probed: the only `docker info` the fake saw is
    // `pg_docker`'s own explicit call, made under the caller's socket.
    expect(dockerCalls(scratch)).toEqual([
      { argv: "info", dockerHost: EXPLICIT },
    ]);
  });

  it("hands the explicit socket to every call ensure_db makes, from the checkout that owns them", async () => {
    // Mutation: delete `[ -z "${DOCKER_HOST:-}" ] &&` from the guard: the fallback rewrites the value
    // before `ensure_db` shell's first compose call, and every call after it records colima.
    const scratch = mkScratch();
    await colimaIsRunning(scratch);
    writeFakeDocker(scratch, 1);

    bash(scratch, 'source "$LOOP"; ensure_db', {
      DOCKER_HOST: EXPLICIT,
      RALPH_DB: "ralph_docker_env_test",
    });

    const calls = dockerRecords(scratch);
    // An explicit socket means the driver does not probe at all, so the fake sees three calls: the
    // start, the existence question and the `createdb` the empty answer leads to. The drive is
    // worthless if the fake never ran, so the argv is asserted as well as the socket.
    expect(calls.map((call) => call.argv)).toEqual([
      "compose up -d --wait postgres",
      "compose exec -T postgres psql -U factory -d factory -tAc select 1 from pg_database where datname='ralph_docker_env_test'",
      "compose exec -T postgres createdb -U factory ralph_docker_env_test",
    ]);
    expect(calls.map((call) => call.dockerHost)).toEqual([
      EXPLICIT,
      EXPLICIT,
      EXPLICIT,
    ]);
    // Every call runs from the checkout `MAIN_ROOT` names, which is what keeps the loop on the main
    // checkout's compose project instead of one named after wherever the loop was started (LOB-57's
    // port-2 hazard, at the driver). `compose.yaml` sets no `name:`, so the directory decides.
    // Mutation: drop the `cd "$MAIN_ROOT" &&` from `ensure_db`'s three calls — the recorded cwd
    // becomes the caller's.
    for (const call of calls) {
      expect(call.cwd, call.argv).toBe(mainRoot());
    }
  });

  it("hands the explicit socket to the pi session, in the environment and in the run context", async () => {
    // The claim the issue is about, one step past `docker_env`: `run_context` writes the socket into
    // the prompt of every iteration and `session` exports it into the `pi -p` it starts, so a value
    // rewritten here is what the agent's own verify-* drives act on. Mutation: delete
    // `[ -z "${DOCKER_HOST:-}" ] &&` — both assertions then read colima's socket, which is exactly
    // the "the loop and the skills disagree" the issue describes, at the point it is felt.
    const scratch = mkScratch();
    await colimaIsRunning(scratch);
    writeFakeDocker(scratch, 1);
    const worktree = path.join(scratch.root, "worktree");
    mkdirSync(path.join(worktree, ".pi/ralph"), { recursive: true });
    writeFileSync(path.join(worktree, ".pi/ralph/work.prompt.md"), "PROMPT\n");
    mkdirSync(path.join(worktree, ".ralph/logs"), { recursive: true });
    mkdirSync(path.join(worktree, ".ralph/sessions"), { recursive: true });
    // A `pi` that records what it was handed: the proof is the agent's own view of the socket, and
    // no iteration is started.
    const piLog = path.join(scratch.root, "pi-calls.txt");
    writeFileSync(
      path.join(scratch.bin, "pi"),
      [
        "#!/usr/bin/env bash",
        `printf 'docker_host=%s\\n' "\${DOCKER_HOST-${UNSET}}" >> ${JSON.stringify(piLog)}`,
        `printf 'argv=%s\\n' "$*" >> ${JSON.stringify(piLog)}`,
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(path.join(scratch.bin, "pi"), 0o755);
    // The premise the case rests on, asserted the way `childEnv` asserts the `docker` shim: this
    // machine has a real `pi` on `PATH`, so a case whose shim went missing would launch the agent
    // CLI, its model provider and its MCP servers, and only then fail here.
    expect(readdirSync(scratch.bin)).toContain("pi");

    const out = bash(scratch, 'source "$LOOP"; docker_env; session 1 work', {
      DOCKER_HOST: EXPLICIT,
      RALPH_WORKTREE: worktree,
      RALPH_FALLBACK_MODELS: "",
      RALPH_TIMEOUT: "5",
    });

    // No control line, one model, clean exit: the tag `cmd_run` would count as a failed iteration.
    expect(out.trim()).toBe("NONE");
    const record = readFileSync(piLog, "utf8");
    expect(record).toContain(`docker_host=${EXPLICIT}\n`);
    expect(record).toContain(`- DOCKER_HOST=${EXPLICIT}\n`);
    expect(record).not.toContain("colima");
    // The file's own rule, applied here too: an explicit socket means `docker_env` does not probe,
    // so the fake saw nothing. Mutation: delete `[ -z "${DOCKER_HOST:-}" ] &&` — a probe appears,
    // carrying the very socket the case claims the driver never looked away from.
    expect(dockerCalls(scratch)).toEqual([]);
  });

  it("still dispatches when it is executed, in the shape each caller uses", async () => {
    // The guard has to be exact: `return 0` when the file is sourced, and the dispatch when it is
    // run. Executed, `$0` and `BASH_SOURCE[0]` are the same string — as given, absolute or relative
    // — including under the argv[0] `cmd_start` re-execs it with (`exec { "bash" } "ralph-loop",
    // @ARGV`, modelled here with bash's own `exec -a`, which execs the same argv shape without
    // needing perl to be on `PATH` in the gate).
    // Mutation: invert the guard (`!=`) — every execution below then exits 0 without printing the
    // usage, and `bun run ralph` becomes a silent no-op.
    const scratch = mkScratch();
    writeFakeDocker(scratch, 1);
    const shapes: ReadonlyArray<readonly [string, readonly string[]]> = [
      // `package.json`'s `"ralph": "bash .pi/ralph/loop.sh"`, from the root.
      [
        "relative, as the package script runs it",
        [path.relative(REPO_ROOT, LOOP)],
      ],
      ["absolute", [LOOP]],
      [
        "under a substituted argv[0], as cmd_start re-execs it",
        ["-c", 'exec -a ralph-loop bash "$LOOP"'],
      ],
    ];

    for (const [label, args] of shapes) {
      const run = spawnSync("bash", [...args], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: childEnv(scratch, {}),
        timeout: 30_000,
      });
      expect(run.status, `${label}: ${run.stderr}`).toBe(64);
      expect(run.stderr, label).toContain("usage:");
    }
    // Dispatched, the driver never reached a docker call of its own: the usage line is the last
    // thing the file does.
    expect(dockerCalls(scratch)).toEqual([]);
  });

  it("defines its functions and runs no subcommand when it is sourced", async () => {
    // Mutation: delete the `[ "${BASH_SOURCE[0]}" = "$0" ] || return 0` line (the sourced half then
    // dispatches `cmd_status`, which dies on the missing worktree and takes the sourcing shell with
    // it, so `rc=0` never prints).
    const scratch = mkScratch();
    writeFakeDocker(scratch, 1);

    const run = bashResult(
      scratch,
      [
        'source "$LOOP" status',
        'printf "rc=%s\\n" "$?"',
        "declare -F docker_env cmd_status cmd_run",
      ].join("\n"),
    );

    expect(run.stderr, run.stdout).toBe("");
    const lines = run.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe("rc=0");
    expect(lines.slice(1).sort()).toEqual([
      "cmd_run",
      "cmd_status",
      "docker_env",
    ]);
  });

  it("never names the CLI by a path, and resolves it to the fake in every case's environment", () => {
    // The false green `docs/testing-third-parties.md` names: a call by absolute path bypasses the
    // fake on `PATH` and reads as "docker was never called" — which is the claim half the cases
    // above rest on. Mutation: a `docker` call in the driver spelled `/usr/local/bin/docker` (M11 in
    // the sweep log) matches the pattern below; unanchored, it would run for real and no case here
    // would notice. The static half is deliberately narrow — one pattern, and no claim about which
    // functions may call docker — so a later issue that adds a docker call elsewhere in the driver
    // does not have to touch this file.
    const withoutComments = readFileSync(LOOP, "utf8")
      .split("\n")
      // Comments hold prose (this file's own header names docker); a message that mentions docker is
      // not a call.
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");

    // No call site names the CLI by a path: `/usr/bin/docker info` would run for real. The strings
    // are kept here — an absolute path is exactly what a blanket string-strip would hide — and the
    // only slash-docker in the file is colima's socket, which no prefix in this pattern reaches.
    expect(withoutComments).not.toMatch(
      /(^|[\s"'`=:;|&(])\/(?:usr|opt|bin|sbin|usr\/local)\S*\bdocker\b/,
    );

    // At run time, in the environment every case above builds: `PATH` resolves docker to the fake.
    const scratch = mkScratch();
    writeFakeDocker(scratch, 1);
    expect(bash(scratch, "command -v docker").trim()).toBe(
      path.join(scratch.bin, "docker"),
    );
    expect(childEnv(scratch, {})["PATH"]).toContain(
      `${scratch.bin}${path.delimiter}`,
    );
  });
});
