import { spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The ralph driver's `ensure_db` must ask the port whether Postgres is up, not compose's exit code
 * (LOB-108).
 *
 * `.pi/ralph/loop.sh` used to run `docker compose up -d --wait postgres` and trust the status, which
 * is the premise LOB-104 and LOB-106 removed from every verify-* skill's shared helper
 * (`.pi/skills/lib/postgres.sh`): compose reports on the start it was asked for, not on the port a
 * caller needs, in either direction. The driver is the one consumer that helper did not cover, and
 * it is the one whose failure is loudest — `cmd_run` calls `ensure_db` before any agent starts, so a
 * database that was up and healthy could still refuse to start the whole loop.
 *
 * These cases drive the real `ensure_db`, sourced out of `.pi/ralph/loop.sh` the way
 * `ralph-docker-env.test.ts` sources `docker_env`, against a fake `docker` first on `PATH`. "A
 * database is answering" is a real `node:net` listener on an ephemeral port passed as `PG_PORT`, so
 * no case touches 5442 — which this suite's own Postgres owns — and no case starts, stops or
 * contacts a container. `ensure_db` ends in `die`, so every drive runs it in a subshell and reads
 * the exit status back.
 *
 * Each case names the mutation it was checked against. A case whose mutation nobody can state is not
 * testing anything.
 *
 * What these cases do **not** cover: `ensure_postgres` itself. `ensure_db` sources the helper from
 * `MAIN_ROOT` — the human's checkout, which is what the issue prescribed — so mutating this
 * worktree's `.pi/skills/lib/postgres.sh` changes nothing in this file. The helper's own cases and
 * their mutation notes live in `postgres-up.test.ts`.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const LOOP = path.join(REPO_ROOT, ".pi/ralph/loop.sh");

/** What the fake records for a variable the child's environment does not have. */
const UNSET = "<unset>";

interface Scratch {
  readonly root: string;
  /** `$HOME` of every child: short, because a unix socket path is capped at 104 bytes. */
  readonly home: string;
  readonly bin: string;
  readonly calls: string;
  /** Where a fake `compose up` that really binds a port records the listener's pid. */
  readonly listenerPid: string;
}

const created: string[] = [];
const listeners: Server[] = [];
afterAll(async () => {
  for (const listener of listeners) listener.close();
  for (const root of created) rmSync(root, { recursive: true, force: true });
});

const mkScratch = (): Scratch => {
  const root = mkdtempSync(path.join(tmpdir(), "factory-ralph-ensure-db-"));
  const home = mkdtempSync(path.join("/tmp", "ralph-edb-"));
  created.push(root, home);
  const bin = path.join(root, "bin");
  mkdirSync(bin, { recursive: true });
  return {
    root,
    home,
    bin,
    calls: path.join(root, "docker-calls.txt"),
    listenerPid: path.join(root, "listener.pid"),
  };
};

/**
 * A listener that holds a port open until it is killed, run under `process.execPath` so the child
 * depends on no `PATH` guess. A plain `node` would be found through the fake `bin` of some other
 * case and could be the machine's, which is the same class of mistake as a fake `docker` that is
 * not on `PATH` at all.
 */
const LISTENER_SOURCE = [
  'const { createServer } = require("node:net");',
  "const server = createServer();",
  'server.listen(Number(process.argv[2]), "127.0.0.1");',
  "",
].join("\n");

/** Whether a pid is still there: `kill -0`, in-process. */
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Wait until `check` holds, so no case depends on a fixed delay. It throws instead of returning:
 * every caller here is asserting. The shape is `postgres-up.test.ts`'s, minus the Effect harness.
 */
const waitFor = async (
  check: () => Promise<boolean>,
  label: string,
): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
};

/** Whether something completes a TCP handshake on `port`. Bash's `/dev/tcp` asks the same thing. */
const doesAnswer = async (port: number): Promise<boolean> => {
  const socket = createConnection({ port, host: "127.0.0.1" });
  try {
    // `once` rejects on the socket's `error`, which is what a refused connect is.
    await once(socket, "connect");
    socket.destroy();
    return true;
  } catch {
    socket.destroy();
    return false;
  }
};

/** The pid a fake `compose up` recorded, if it opened a listener. */
const recordedListener = (scratch: Scratch): number | undefined => {
  if (!existsSync(scratch.listenerPid)) return undefined;
  const pid = Number(readFileSync(scratch.listenerPid, "utf8"));
  return Number.isFinite(pid) && pid > 0 ? pid : undefined;
};

/** Kill the listener a fake `compose up` opened, and wait for the port to refuse again. */
const stopOpenedListener = async (
  scratch: Scratch,
  port: number,
): Promise<void> => {
  const pid = recordedListener(scratch);
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone: the case's compose never started one, or the listener died with its port.
  }
  await waitFor(
    async () => !(await doesAnswer(port)),
    `port ${String(port)} to refuse again`,
  );
  await waitFor(async () => !isAlive(pid), `pid ${String(pid)} to be gone`);
};

/**
 * A `docker` that records every call's argv, cwd and `DOCKER_HOST`, and answers from the environment
 * of the drive that wrote it. The record is a file, not stdout: `ensure_postgres` redirects its
 * compose call to `/dev/null`, so a stub that printed would record nothing.
 *
 * Three knobs, all read per call so one fake serves every case:
 * - `FAKE_OWNER` — what `ps --filter publish=…` prints. Empty means "no container publishes the
 *   port", which is the native-server / tunnel case and the reason `ensure_db` has a compose
 *   fallback at all.
 * - `FAKE_PSQL_OUT` — what `exec … psql -tAc "select 1 from pg_database…"` prints. Empty means the
 *   database is not there, which is what leads to `createdb`.
 * - `FAKE_COMPOSE_EXIT` — the exit code of every `compose` invocation. 0 with nothing listening is
 *   the LOB-104 case: a compose that reports success and leaves the port refused.
 *
 * `psql` is matched anywhere in the argv rather than at the start: the existence question reaches
 * the fake both as `exec <container> psql …` and as `compose exec -T postgres psql …`, and a pattern
 * anchored on `exec` alone would send the compose form to the compose branch and record an empty
 * answer — which reads as "the database is not there" and sends the drive down the `createdb` path
 * for a reason that has nothing to do with the case.
 */
const writeFakeDocker = (
  scratch: Scratch,
  options: {
    /**
     * The port a `compose up` should really bind before it exits. Left out, the same fake models a
     * compose that reports success and leaves nothing answering, which is AC1's case.
     */
    readonly opensPort?: number;
  } = {},
): void => {
  const file = path.join(scratch.bin, "docker");
  const port = options.opensPort;
  if (port !== undefined) {
    writeFileSync(path.join(scratch.root, "listener.cjs"), LISTENER_SOURCE);
  }
  // A compose that reports success has to leave something answering: the `--wait` it models would
  // not have returned otherwise. So bind a real listener, wait for the bind, and only then exit.
  const upBranch =
    port === undefined
      ? ['  compose*) exit "${FAKE_COMPOSE_EXIT:-0}" ;;']
      : [
          "  compose*)",
          `    ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(scratch.root, "listener.cjs"))} ${String(port)} >/dev/null 2>&1 &`,
          `    printf '%s' "$!" > ${JSON.stringify(scratch.listenerPid)}`,
          `    for _ in $(seq 1 250); do (exec 3<>\"/dev/tcp/127.0.0.1/${String(port)}\") 2>/dev/null && break; sleep 0.02; done`,
          '    exit "${FAKE_COMPOSE_EXIT:-0}" ;;',
        ];
  writeFileSync(
    file,
    [
      "#!/usr/bin/env bash",
      `printf 'argv=%s\\tcwd=%s\\tdocker_host=%s\\n' "$*" "$PWD" "\${DOCKER_HOST-${UNSET}}" >> "$FAKE_CALLS"`,
      'case "$*" in',
      "  info) exit 0 ;;",
      "  ps*) printf '%s\\n' \"${FAKE_OWNER-}\" ;;",
      "  *psql*) printf '%s\\n' \"${FAKE_PSQL_OUT-}\" ;;",
      ...upBranch,
      "  *) exit 0 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(file, 0o755);
};

/**
 * The environment of a child. The parent's `DOCKER_HOST` is deleted on purpose — this repo's own
 * ralph driver exports one — so a case that wants it unset gets it unset, and only `extra` decides
 * what the case is about. Same `Object.entries` read as `turbo-env.test.ts`: a direct
 * `process.env.NAME` is configuration, and a test inheriting a shell's value is not configuring.
 *
 * The fake has to exist before a child runs: a case that forgot `writeFakeDocker` would drive the
 * machine's real CLI, whose answer depends on the machine — and the cases whose claim is "no compose
 * was called" could pass on it. This asserts the premise every case rests on instead of letting a
 * harness slip read as a green.
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
    FAKE_CALLS: scratch.calls,
  };
  delete env["DOCKER_HOST"];
  return { ...env, ...extra };
};

interface BashRun {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run `ensure_db` in a subshell and hand back everything it did. The subshell is the point:
 * `ensure_db` ends in `die`, which is `exit 1`, and a case that expected that as a plain statement
 * would take the whole child with it before it could print the status.
 */
const ensureDb = (
  scratch: Scratch,
  extra: Record<string, string> = {},
): BashRun => {
  const run = spawnSync(
    "bash",
    [
      "-c",
      'source "$LOOP"; rc=0; ( ensure_db ) || rc=$?; printf "rc=%s\\n" "$rc"',
    ],
    {
      cwd: scratch.root,
      encoding: "utf8",
      env: childEnv(scratch, extra),
      timeout: 30_000,
    },
  );
  const stdout = run.stdout ?? "";
  const rc = /^rc=(-?\d+)\s*$/.exec(stdout.trim());
  return {
    status: rc ? Number(rc[1]) : -1,
    stdout,
    stderr: run.stderr ?? "",
  };
};

/**
 * A port nothing answers on, so `pg_port_open` refuses the connect. An ephemeral port is taken and
 * released, then confirmed to refuse — and retried, because the release is asynchronous: without
 * the `close` event the handle can still hold the port, and `databaseIsUp` would then fail with
 * `EADDRINUSE`, or a stranger would take the port in the window and AC1's case would read as
 * "something is answering" (status 0) for a reason that has nothing to do with the driver. Same
 * helper, same reasoning, as `postgres-up.test.ts`'s `closedPort`.
 */
const closedPort = async (): Promise<number> => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const probe = createServer();
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    const address = probe.address();
    probe.close();
    await once(probe, "close");
    if (address === null || typeof address === "string") continue;
    if (!(await doesAnswer(address.port))) return address.port;
  }
  throw new Error("no closed port was available to drive ensure_db");
};

/** A real listener on `port`: "a database is answering", without a container and without 5442. */
const databaseIsUp = async (port: number): Promise<Server> => {
  const listener = createServer();
  listener.listen(port, "127.0.0.1");
  // Registered before the await, so a listener that bound but never reported `listening` is still
  // closed by `afterAll` instead of holding the port for the rest of the worker's life.
  listeners.push(listener);
  await once(listener, "listening");
  return listener;
};

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

const composeCalls = (scratch: Scratch): DockerCall[] =>
  dockerRecords(scratch).filter((call) => call.argv.startsWith("compose"));

/**
 * The calls `ensure_db` decides to make, with `pg_docker`'s own probe removed. Every `pg_docker`
 * invocation runs `docker info` first — that is its colima fallback asking whether the active context
 * answers — so the raw record carries one `info` per real call and the sequence of decisions is
 * unreadable underneath them. The probe is not `ensure_db`'s decision and no case here is about it;
 * `dockerRecords` keeps it for the case that asserts a `DOCKER_HOST` on every call.
 */
const driverCalls = (scratch: Scratch): DockerCall[] =>
  dockerRecords(scratch).filter((call) => call.argv !== "info");

/**
 * The checkout `MAIN_ROOT` names: the parent of the repository's common git directory. Derived the
 * way `loop.sh` derives it, because in a ralph worktree that is the human's checkout and not the
 * directory this suite runs from — which is the whole reason `ensure_db` pins `PG_ROOT`.
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

/** `ensure_db`'s own body, as written in the driver — what the last case reads back. */
const ensureDbBody = (): string => {
  const source = readFileSync(LOOP, "utf8");
  const start = source.search(/^ensure_db\(\) \{$/m);
  expect(start, "ensure_db is declared in .pi/ralph/loop.sh").toBeGreaterThan(
    -1,
  );
  const end = source.indexOf("\n}\n", start);
  expect(end, "ensure_db is closed in .pi/ralph/loop.sh").toBeGreaterThan(
    start,
  );
  return source.slice(start, end);
};

describe("the ralph driver's ensure_db", () => {
  it(
    "fails loudly when a compose that exits 0 leaves nothing answering on the port",
    { timeout: 30_000 },
    async () => {
      // AC1, and the case the issue is about. `ensure_postgres` discards compose's exit code and asks
      // the port instead, so a start that reports success with the port refused is a failure here
      // rather than a loop launched against a database that is not there. Mutation: replace
      // `ensure_postgres ||` with `(cd "$MAIN_ROOT" && docker compose up -d --wait postgres) >&2 ||`
      // — the pre-LOB-108 body. The status goes 0 and the stderr loses the port.
      const scratch = mkScratch();
      const port = await closedPort();
      writeFakeDocker(scratch);

      const run = ensureDb(scratch, { PG_PORT: String(port) });

      expect(run.status, run.stderr).not.toBe(0);
      expect(run.stderr).toContain(
        `postgres is not up on port ${String(port)}`,
      );
      // It did ask compose to start something, and ran that from the checkout that owns the database's
      // project — the worktree's own `factory-ralph` project would collide with the human's on 5442
      // (LOB-57) even on the start path.
      expect(composeCalls(scratch).map((call) => call.argv)).toEqual([
        "compose up -d --wait postgres",
        // The `Created`-container cleanup, which is the helper's and not `ensure_db`'s: a failed
        // start leaves a container holding the port reservation, and removing exactly that is what
        // makes the next run work once 5442 is free.
        "compose ps -aq --status created postgres",
      ]);
      for (const call of composeCalls(scratch)) {
        expect(call.cwd, call.argv).toBe(mainRoot());
      }
    },
  );

  it(
    "calls no compose at all when a database already answers on the port",
    { timeout: 30_000 },
    async () => {
      // AC2. `ensure_postgres` returns on its first probe, so the only docker calls left are the ones
      // needed to ask a question of the database that is already there. Mutation: delete the
      // `pg_port_open && return 0` short-circuit inside `ensure_postgres` — a `compose up` appears in
      // the record, and on a host where the port is held by a native server that compose cannot
      // start, the case goes red on the status too.
      const scratch = mkScratch();
      const port = await closedPort();
      await databaseIsUp(port);
      writeFakeDocker(scratch);

      const run = ensureDb(scratch, {
        PG_PORT: String(port),
        FAKE_OWNER: "factory-postgres-1",
        FAKE_PSQL_OUT: "1",
      });

      expect(run.status, run.stderr).toBe(0);
      expect(composeCalls(scratch)).toEqual([]);
      // The existence question went to the container that publishes the port, by `docker exec`, which
      // reaches a project `compose exec` cannot: the human's `factory-postgres-1` usually holds 5442.
      expect(driverCalls(scratch).map((call) => call.argv)).toEqual([
        `ps --filter publish=${String(port)} --format {{.Names}}`,
        "exec factory-postgres-1 psql -U factory -d factory -tAc select 1 from pg_database where datname='factory_ralph'",
      ]);
    },
  );

  it(
    "falls back to compose exec when nothing publishes the port as a container",
    { timeout: 30_000 },
    async () => {
      // The other half of AC2's mechanism: a database can answer on the port without a container
      // owning it (a native server, a tunnel), and `compose exec` can only reach the project of the
      // directory it runs from. Mutation: flip the branch test to `[ -z "$owner" ]` — `pg_port_owner`
      // still runs, so the `ps` call stays in the record and the red is the exec that follows it:
      // `compose exec -T postgres psql …` where the case demands the container that publishes the
      // port. (Deleting the `if` outright reddens the case too, on the status: `pgin` is then never
      // defined and the subshell dies 127 on `command not found`.)
      const scratch = mkScratch();
      const port = await closedPort();
      await databaseIsUp(port);
      writeFakeDocker(scratch);

      const run = ensureDb(scratch, {
        PG_PORT: String(port),
        FAKE_OWNER: "",
        FAKE_PSQL_OUT: "1",
      });

      expect(run.status, run.stderr).toBe(0);
      expect(driverCalls(scratch).map((call) => call.argv)).toEqual([
        `ps --filter publish=${String(port)} --format {{.Names}}`,
        "compose exec -T postgres psql -U factory -d factory -tAc select 1 from pg_database where datname='factory_ralph'",
      ]);
      // And that compose call runs from the checkout that owns the project, not from the worktree.
      for (const call of composeCalls(scratch)) {
        expect(call.cwd, call.argv).toBe(mainRoot());
      }
    },
  );

  it(
    "creates the database in whichever postgres answers, and says so",
    { timeout: 30_000 },
    async () => {
      // The `createdb` half, which is the only write `ensure_db` does. An empty `psql` answer means
      // the database is not there yet. Mutation: drop the `if [ "$exists" != "1" ]` guard — the
      // `createdb` call disappears from the record.
      const scratch = mkScratch();
      const port = await closedPort();
      await databaseIsUp(port);
      writeFakeDocker(scratch);

      const run = ensureDb(scratch, {
        PG_PORT: String(port),
        FAKE_OWNER: "factory-postgres-1",
        FAKE_PSQL_OUT: "",
        RALPH_DB: "ralph_lob108_probe",
      });

      expect(run.status, run.stderr).toBe(0);
      expect(driverCalls(scratch).map((call) => call.argv)).toEqual([
        `ps --filter publish=${String(port)} --format {{.Names}}`,
        "exec factory-postgres-1 psql -U factory -d factory -tAc select 1 from pg_database where datname='ralph_lob108_probe'",
        "exec factory-postgres-1 createdb -U factory ralph_lob108_probe",
      ]);
    },
  );

  it(
    "leaves an explicit DOCKER_HOST alone, on every call ensure_db makes",
    { timeout: 30_000 },
    async () => {
      // The driver and the helper it now sources must agree on which daemon is authoritative (LOB-105
      // is the same promise one file over). `ensure_db` calls `docker_env` first, so a value rewritten
      // there is what every later call records. Mutation: make the colima fallback in `docker_env`
      // unconditional — drop the guard, the probe and the socket test, so the `if` body always runs —
      // and every recorded `docker_host` becomes colima's socket. The case is about an explicit value
      // surviving every call, not about the guard's own arithmetic: in this case's environment
      // (`$HOME` is a bare scratch dir with no colima socket, and the fake's `info` exits 0) the
      // guard's clauses are unreachable, and `ralph-docker-env.test.ts` owns the mutations that redden
      // each of them.
      const scratch = mkScratch();
      const port = await closedPort();
      await databaseIsUp(port);
      writeFakeDocker(scratch);
      const explicit = "unix:///var/run/docker.sock";

      const run = ensureDb(scratch, {
        PG_PORT: String(port),
        FAKE_OWNER: "factory-postgres-1",
        FAKE_PSQL_OUT: "1",
        DOCKER_HOST: explicit,
      });

      expect(run.status, run.stderr).toBe(0);
      const calls = dockerRecords(scratch);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.dockerHost, call.argv).toBe(explicit);
      }
    },
  );

  it(
    "asks the container compose just started, when nothing answered before",
    { timeout: 30_000 },
    async () => {
      // The path a fresh machine takes: `loop.sh setup` on a host where 5442 answers nothing yet.
      // `ensure_postgres` starts the database with compose and the port answers afterwards, so the
      // existence question — and the `createdb` — have to go to the container that now publishes
      // the port, not to the project this directory would name. The fake's `compose up` really binds
      // the port (through `process.execPath`, so the child depends on no `PATH` guess) before it
      // exits 0; `postgres-up.test.ts` owns the start half and the cases above own the ask half, so
      // this is the composition between them. Mutation: flip the branch test to `[ -z "$owner" ]` —
      // both the `psql` and the `createdb` go to `compose exec -T postgres` instead of the owner.
      const scratch = mkScratch();
      const port = await closedPort();
      writeFakeDocker(scratch, { opensPort: port });
      try {
        const run = ensureDb(scratch, {
          PG_PORT: String(port),
          FAKE_OWNER: "factory-postgres-1",
          FAKE_PSQL_OUT: "",
          RALPH_DB: "ralph_lob108_probe",
        });

        expect(run.status, run.stderr).toBe(0);
        expect(driverCalls(scratch).map((call) => call.argv)).toEqual([
          "compose up -d --wait postgres",
          `ps --filter publish=${String(port)} --format {{.Names}}`,
          "exec factory-postgres-1 psql -U factory -d factory -tAc select 1 from pg_database where datname='ralph_lob108_probe'",
          "exec factory-postgres-1 createdb -U factory ralph_lob108_probe",
        ]);
        // And the start happened from the checkout that owns the database's project.
        for (const call of composeCalls(scratch)) {
          expect(call.cwd, call.argv).toBe(mainRoot());
        }
      } finally {
        await stopOpenedListener(scratch, port);
      }
    },
  );

  it(
    "proves the fake is what PATH resolves before any case relies on it",
    { timeout: 30_000 },
    () => {
      // Every case's premise: `ensure_db` reaches the fake and not the machine's CLI. `childEnv`
      // asserts the fake file exists; this asserts the resolution, the way `postgres-up.test.ts` and
      // `ralph-docker-env.test.ts` do. Without it the "no compose was called" assertions are false
      // greens: a `PATH` that missed the fake would record nothing, and an empty record reads as
      // exactly the thing the case is asserting. Mutation: drop the fake `bin` from `childEnv`'s
      // `PATH` — this case is red on the machine's own path to docker.
      const scratch = mkScratch();
      writeFakeDocker(scratch);

      const run = spawnSync("bash", ["-c", "command -v docker"], {
        cwd: scratch.root,
        encoding: "utf8",
        env: childEnv(scratch, {}),
      });

      expect(run.stdout.trim()).toBe(path.join(scratch.bin, "docker"));
    },
  );

  it("sources the shared helper rather than asking compose itself", async () => {
    // The structural half of the fix, read back out of the driver so a future edit cannot quietly
    // reintroduce a second rule. `ensure_db` must get "is Postgres up?" from
    // `.pi/skills/lib/postgres.sh` — the one place LOB-104 and LOB-106 put it — and must not contain
    // a `compose up` of its own. Mutation: replace `ensure_postgres ||` with
    // `(cd "$MAIN_ROOT" && docker compose up -d --wait postgres) >&2 ||` and both assertions go
    // red; the first case in this file goes red with it too.
    const body = ensureDbBody();

    expect(body).toContain("ensure_postgres");
    expect(body).toContain('source "$MAIN_ROOT/.pi/skills/lib/postgres.sh"');
    expect(body).not.toMatch(/compose up/);
    // `PG_ROOT` is pinned, not exported: the helper derives its root from its own path, and this file
    // is sourced from a worktree, so without the pin the compose project would be named after the
    // worktree. A plain assignment also means no agent session inherits it.
    expect(body).toContain('PG_ROOT="$MAIN_ROOT"');
    expect(body).not.toContain("export PG_ROOT");
  });
});
