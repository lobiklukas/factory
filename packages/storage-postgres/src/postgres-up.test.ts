import { spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The verify-* skills must accept a Postgres that is already up (LOB-57).
 *
 * `docker compose up -d --wait postgres` is not an "is there a database?" check: compose names its
 * project after `COMPOSE_PROJECT_NAME` when it is set and the directory otherwise, so a plain shell
 * in a ralph worktree asks for project `factory-ralph` and tries to bind host port 5442 a second
 * time. While the human's `factory-postgres-1` holds 5442
 * that fails with "port is already allocated" and leaves a `Created` container behind — while the
 * database the skills need is up and healthy. Every skill therefore asks the port first
 * (`.pi/skills/lib/postgres.sh`) and calls compose only when nothing answers.
 *
 * These cases drive that precondition with a fake `docker` executable on PATH — the third-party
 * boundary, per `docs/testing-third-parties.md` — and a real TCP listener standing in for a
 * database that answers. No case here starts, stops or contacts a container, and no case touches
 * 5442: the probe port is passed as `PG_PORT`, so the gate's own Postgres is never in the way.
 *
 * Compose's exit code is not the claim either (LOB-104): `--wait` reports on its healthcheck, so a
 * start whose container comes up and leaves can exit 0 with nothing answering, and a caller would
 * then launch against a database that is not there and leave its own process behind. The fake
 * `docker` can therefore be asked to *really* open a listener when it reports success, and the
 * cases below cover both halves: a compose that says so and answers, and one that says so and not.
 *
 * Compose's exit code is not the claim in the other direction either (LOB-106): it may have failed
 * only because another agent's `compose up` won the port between the probe and this call, so the
 * port is asked after a failed attempt too, and the failure is discarded.
 *
 * The file lives in `@repo/storage-postgres` for the same reason `turbo-env.test.ts` does: it is a
 * repo-level Postgres claim that belongs to no package, and it needs no database to run.
 *
 * Each case below names the mutation it was checked against — the one-line change that makes it go
 * red. A case whose mutation nobody can state is not testing anything. "Names" is meant
 * mechanically: the note is a `//` comment line inside the case that carries the marker
 * `Mutation checked:` on that one line, and the last case in this file reads the file back and
 * fails when a case has none. That is not decoration — six cases had drifted away from the claim by
 * the time it was measured (LOB-107), which is how a header stops being true.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const LIB = path.join(REPO_ROOT, ".pi/skills/lib/postgres.sh");

/** The skill scripts that own a Postgres precondition. */
const CALLERS = [
  ".pi/skills/verify-api/up.sh",
  ".pi/skills/verify-api/sigterm.sh",
  ".pi/skills/verify-api/degraded.sh",
  ".pi/skills/verify-cli/up.sh",
  ".pi/skills/verify-web/up.sh",
] as const;

/** `up.sh` per skill: a script that must start its API while Postgres already answers. */
const UP_SCRIPTS = ["verify-api", "verify-cli", "verify-web"] as const;

/** The marker a case's mutation note carries, on one comment line. */
const MUTATION_NOTE = "Mutation checked:";

/**
 * Whether a line is a case's mutation note. `//` lines only: a note is documentation, and a string
 * literal that happens to carry the marker is not one — otherwise an assertion could satisfy the
 * scan that the last case in this file runs.
 */
const isMutationNote = (line: string): boolean =>
  /^\s*\/\//.test(line) && line.includes(MUTATION_NOTE);

interface Scratch {
  readonly root: string;
  readonly bin: string;
  readonly dockerCalls: string;
  readonly dockerDetail: string;
  readonly bunRan: string;
  /** Where a fake `docker` records the listener it started, when a case asked it to open the port. */
  readonly listenerPid: string;
}

const created: string[] = [];
afterAll(() => {
  for (const root of created) rmSync(root, { recursive: true, force: true });
});

const mkScratch = (): Scratch => {
  const root = mkdtempSync(
    path.join(tmpdir(), "factory-postgres-precondition-"),
  );
  created.push(root);
  const bin = path.join(root, "bin");
  mkdirSync(bin, { recursive: true });
  return {
    root,
    bin,
    dockerCalls: path.join(root, "docker-calls.txt"),
    dockerDetail: path.join(root, "docker-detail.txt"),
    bunRan: path.join(root, "bun-ran"),
    listenerPid: path.join(root, "listener.pid"),
  };
};

/**
 * The listener a fake `docker` starts when a case wants a compose that really brings a database up.
 * Started with `process.execPath` — the runtime running this suite — so the child depends on no
 * `PATH` guess, and written to a file rather than passed as an inline `-e` string so the same text
 * runs under `bun` and under `node`. It holds the port open until `stopOpenedListener` kills it.
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
 * Wait until `check` holds, so a case never depends on a fixed delay — the primitive `harness.ts`
 * uses without Effect. It throws instead of returning: every caller here is asserting.
 */
const waitFor = async (
  check: () => Promise<boolean>,
  label: string,
): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await delay(25);
  }
  throw new Error(`timed out waiting for ${label}`);
};

/** The pid a fake `docker` recorded for the listener it started, if it recorded a usable one. */
const recordedListener = (scratch: Scratch): number | undefined => {
  if (!existsSync(scratch.listenerPid)) return undefined;
  const pid = Number(readFileSync(scratch.listenerPid, "utf8"));
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
};

/**
 * The pid of the listener a fake `docker` started, stopped so a case cannot leak a bound port.
 *
 * The port is the hazard, not the pid: a listener that outlived its case is an open port every later
 * case has to guess around, and a child nobody accounts for. So this waits until the port refuses
 * again and the pid is gone, and fails the case that leaked rather than the one that trips over it.
 *
 * `pg_compose`'s successful branch is the only thing that opens a port, so a case whose compose
 * never reported success has nothing to stop — and `pid <= 0` is load-bearing, because a malformed
 * record holding 0 or -1 must never reach `process.kill`, which would signal this process's whole
 * group (or every process the user owns).
 */
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
 * A `docker` that records every call and fails `compose up` by default.
 *
 * Failing `compose up` is what the real command does in a ralph worktree; every other subcommand
 * answers benignly, so a case can tell "compose was called" from "the command happened to fail".
 * The second log records the working directory and `DOCKER_HOST` of each call: the whole bug is
 * about the directory compose derives its project name from, and about which socket it talks to.
 */
const writeFakeDocker = (
  scratch: Scratch,
  upExit: number,
  options: {
    readonly infoExit?: number;
    /**
     * The port a successful `compose up` should really open a listener on. Left out, the fake
     * models a compose that reports success and leaves nothing answering — LOB-104's case.
     */
    readonly opensPort?: number;
  } = {},
): void => {
  const file = path.join(scratch.bin, "docker");
  const calls = JSON.stringify(scratch.dockerCalls);
  const detail = JSON.stringify(scratch.dockerDetail);
  const port = options.opensPort;
  if (port !== undefined) {
    writeFileSync(path.join(scratch.root, "listener.cjs"), LISTENER_SOURCE);
  }
  // A compose that reports success has to leave something answering: the `--wait` it models would
  // not have returned otherwise. So bind a real listener, wait for the bind, and only then exit.
  const upBranch =
    port === undefined
      ? [`    exit ${String(upExit)} ;;`]
      : [
          `    ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(scratch.root, "listener.cjs"))} ${String(port)} >/dev/null 2>&1 &`,
          `    printf '%s' "$!" > ${JSON.stringify(scratch.listenerPid)}`,
          `    for _ in $(seq 1 250); do (exec 3<>"/dev/tcp/127.0.0.1/${String(port)}") 2>/dev/null && break; sleep 0.02; done`,
          `    exit ${String(upExit)} ;;`,
        ];
  writeFileSync(
    file,
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> ${calls}`,
      `printf 'argv=%s\\tcwd=%s\\tdocker_host=%s\\n' "$*" "$PWD" "\${DOCKER_HOST:-<unset>}" >> ${detail}`,
      'case "$*" in',
      `  info) exit ${String(options.infoExit ?? 0)} ;;`,
      '  *"compose up"*)',
      ...upBranch,
      // What a failed start left in `Created`, as `docker compose ps -q --status created` reports it.
      '  *"compose ps"*) [ -n "${FAKE_DOCKER_CREATED:-}" ] && printf \'%s\\n\' "$FAKE_DOCKER_CREATED"; exit 0 ;;',
      // What `docker ps --filter publish=<port>` would list, one name per line.
      '  *"--filter publish="*) [ -n "${FAKE_DOCKER_PS:-}" ] && printf \'%s\\n\' "$FAKE_DOCKER_PS"; exit 0 ;;',
      // A container `degraded.sh` stops and starts, so its own "is it stopped?" check and its `EXIT`
      // trap can be driven: `ps` stops naming it while the state file says so.
      '  stop\\ *) [ -n "${FAKE_DOCKER_STATE:-}" ] && printf stopped > "$FAKE_DOCKER_STATE"; exit 0 ;;',
      '  start\\ *) [ -n "${FAKE_DOCKER_STATE:-}" ] && printf running > "$FAKE_DOCKER_STATE"; exit 0 ;;',
      '  ps\\ *) if [ -n "${FAKE_DOCKER_PS:-}" ] && [ "$(cat "${FAKE_DOCKER_STATE:-/nonexistent}" 2>/dev/null)" != stopped ]; then printf \'%s\\n\' "$FAKE_DOCKER_PS"; fi; exit 0 ;;',
      "  *) exit 0 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(file, 0o755);
};

/** A `bun` and a `curl` that do nothing, so a copied `up.sh` can reach its own happy path. */
const writeFakeBunAndCurl = (scratch: Scratch): void => {
  for (const name of ["bun", "curl"]) {
    const file = path.join(scratch.bin, name);
    writeFileSync(file, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(file, 0o755);
  }
};

/**
 * A `bun` that leaves a mark, so a case can prove no process was launched, and a `curl` that says
 * every URL is ready, so a caller that wrongly gets past the precondition exits at once instead of
 * spending its 30-second readiness loop.
 *
 * `markerDelayMs` makes the mark land late on purpose. `up.sh` backgrounds its launch and its own
 * `curl` stub answers on the first turn, so the script is done before the forked `bun` has run — the
 * mark legitimately arrives after `spawnSync` returns, and a case that asserts the launch happened
 * has to wait for it. Setting the delay turns that race into a certainty, so the wait is load-bearing
 * rather than a cure for a flake.
 */
const writeMarkingBunAndReadyCurl = (
  scratch: Scratch,
  options: { readonly markerDelayMs?: number } = {},
): void => {
  const bun = path.join(scratch.bin, "bun");
  // `markerDelay`, not `delay`: the module-level `delay` belongs to `waitFor`.
  const markerDelay =
    options.markerDelayMs === undefined
      ? ""
      : `sleep ${String(options.markerDelayMs / 1000)}\n`;
  writeFileSync(
    bun,
    `#!/usr/bin/env bash\n${markerDelay}printf '%s\\n' "$*" >> ${JSON.stringify(scratch.bunRan)}\nexit 0\n`,
  );
  chmodSync(bun, 0o755);
  const curl = path.join(scratch.bin, "curl");
  writeFileSync(curl, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(curl, 0o755);
};

/**
 * The same, except that the API launch stays alive: `degraded.sh`'s last case checks that one
 * process served both phases, which needs a pid that is still there. `exec` keeps the pid the
 * script recorded, because these scripts `exec` their way into the process they write down.
 */
const writeLongLivedApiBunAndReadyCurl = (scratch: Scratch): void => {
  writeMarkingBunAndReadyCurl(scratch);
  writeFileSync(
    path.join(scratch.bin, "bun"),
    [
      "#!/usr/bin/env bash",
      'case "$*" in',
      // The API the lifecycle script starts; the drivers it runs are instant.
      "  *src/index.ts*) exec sleep 20 ;;",
      "  *) exit 0 ;;",
      "esac",
      "",
    ].join("\n"),
  );
};

const dockerCalls = (scratch: Scratch): string[] => {
  try {
    return readFileSync(scratch.dockerCalls, "utf8")
      .split("\n")
      .filter((line) => line !== "");
  } catch {
    return [];
  }
};

/** Every call that is not `pg_docker`'s `docker info` reachability probe. */
const subcommands = (scratch: Scratch): string[] =>
  dockerCalls(scratch).filter((call) => call !== "info");

/** The compose calls alone, in order — the argv that decides whether a container is created. */
const composeCalls = (scratch: Scratch): string[] =>
  subcommands(scratch).filter((call) => call.startsWith("compose "));

interface DockerRecord {
  readonly argv: string;
  readonly cwd: string;
  readonly dockerHost: string;
}

const dockerRecords = (scratch: Scratch): DockerRecord[] => {
  try {
    return readFileSync(scratch.dockerDetail, "utf8")
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

const recordOf = (scratch: Scratch, argv: string): DockerRecord => {
  const record = dockerRecords(scratch).find(
    (candidate) => candidate.argv === argv,
  );
  if (record === undefined) throw new Error(`docker never ran \`${argv}\``);
  return record;
};

const childEnv = (
  scratch: Scratch,
  port: number,
  extra: Record<string, string> = {},
): Record<string, string> => {
  // `Object.entries`, not `process.env["NAME"]`: the repo's Effect lint reads a direct property
  // access as configuration that belongs in `Config`, and a test inheriting the shell's environment
  // is not configuring anything. Same pattern as `turbo-env.test.ts`.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  return {
    ...inherited,
    PATH: `${scratch.bin}${path.delimiter}${inherited["PATH"] ?? ""}`,
    PG_PORT: String(port),
    ...extra,
  };
};

/** The same environment with no `PG_PORT` at all, for the case that reads the default. */
const envWithoutPort = (scratch: Scratch): Record<string, string> => {
  const env = childEnv(scratch, 0);
  delete env["PG_PORT"];
  return env;
};

/** Run `ensure_postgres` from the shared library, the way every skill does. */
const ensurePostgres = (
  scratch: Scratch,
  port: number,
  extra: Record<string, string> = {},
) =>
  spawnSync("bash", ["-c", 'source "$PG_LIB"; ensure_postgres'], {
    cwd: scratch.root,
    encoding: "utf8",
    env: { ...childEnv(scratch, port, extra), PG_LIB: LIB },
    timeout: 30_000,
  });

/**
 * The library and one caller, laid out in a scratch root exactly as they sit in the repo, so the
 * caller's own `ROOT` resolves to the scratch root and nothing it starts can touch the checkout.
 * `apps/api` and `apps/web` exist so a caller that wrongly gets past the precondition can run its
 * launch line instead of failing on a missing directory.
 */
const stageCaller = (scratch: Scratch, caller: string): string => {
  mkdirSync(path.join(scratch.root, ".pi/skills/lib"), { recursive: true });
  cpSync(LIB, path.join(scratch.root, ".pi/skills/lib/postgres.sh"));
  const staged = path.join(scratch.root, caller);
  mkdirSync(path.dirname(staged), { recursive: true });
  cpSync(path.join(REPO_ROOT, caller), staged);
  for (const app of ["api", "web"]) {
    mkdirSync(path.join(scratch.root, "apps", app), { recursive: true });
  }
  return staged;
};

/**
 * A listener that answers for the duration of one case, standing in for a healthy database.
 * `events.once`, not `new Promise`: this repo's lint denies manual promise construction, and
 * `node:net`'s callbacks are all `once` needs.
 */
const answeringPort = async (): Promise<{
  port: number;
  close: () => Promise<void>;
}> => {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  return {
    port: (listener.address() as AddressInfo).port,
    close: async () => {
      listener.close();
      await once(listener, "close");
    },
  };
};

/**
 * A listener that completes the handshake and hangs up at once. Bash's `/dev/tcp` reports the
 * connect, not a conversation: reachability is the claim, so this must still count as "answered".
 */
const hangUpPort = async (): Promise<{
  port: number;
  close: () => Promise<void>;
}> => {
  const listener = createServer((socket) => {
    socket.destroy();
  });
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  return {
    port: (listener.address() as AddressInfo).port,
    close: async () => {
      listener.close();
      await once(listener, "close");
    },
  };
};

/** Whether a TCP connect to `port` succeeds, i.e. whether the precondition would call it up. */
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

/**
 * A port nothing answers on. An ephemeral port is taken and released, then confirmed to refuse:
 * a port number guessed out of the air could be a database, and a hard-coded one could be taken by
 * a parallel test file between the guess and the run.
 */
const closedPort = async (): Promise<number> => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const released = await answeringPort();
    await released.close();
    if (!(await doesAnswer(released.port))) return released.port;
  }
  throw new Error("no closed port was available to test the fallback path");
};

/** A `$HOME` holding colima's socket, which is what `pg_docker`'s fallback looks for. */
const colimaHome = async (): Promise<{
  home: string;
  socket: string;
  close: () => Promise<void>;
}> => {
  const home = mkdtempSync(path.join(tmpdir(), "factory-colima-"));
  created.push(home);
  const dir = path.join(home, ".colima/default");
  mkdirSync(dir, { recursive: true });
  const socket = path.join(dir, "docker.sock");
  const server = createServer();
  server.listen(socket);
  await once(server, "listening");
  return {
    home,
    socket,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
};

describe("the verify-* skills' Postgres precondition", () => {
  it(
    "leaves a database that already answers alone, without calling docker",
    { timeout: 30_000 },
    async () => {
      const scratch = mkScratch();
      writeFakeDocker(scratch, 1);
      const database = await answeringPort();
      try {
        const result = ensurePostgres(scratch, database.port);
        expect(result.status, result.stderr).toBe(0);
        // Mutation checked: dropping the `pg_port_open && return 0` line at the top of
        // `ensure_postgres` — the helper goes on to ask compose about a database that is already up,
        // which is the LOB-57 bug from the caller's side.
        expect(dockerCalls(scratch)).toEqual([]);
        // The helper is silent on the path every skill takes on a developer machine.
        expect(result.stdout).toBe("");
      } finally {
        await database.close();
      }
    },
  );

  it("starts Postgres with compose when nothing answers on the port", async () => {
    const scratch = mkScratch();
    const port = await closedPort();
    // A compose that behaves: it exits 0 *and* the port answers afterwards, which is what `--wait`
    // promises. Leaving this fake without `opensPort` is the next case.
    writeFakeDocker(scratch, 0, { opensPort: port });
    try {
      const result = ensurePostgres(scratch, port);
      expect(result.status, result.stderr).toBe(0);
      expect(composeCalls(scratch)).toEqual(["compose up -d --wait postgres"]);
      // Compose names its project after the directory it runs in, so the call has to happen from
      // the root the helper belongs to: from anywhere else it addresses a project nobody else can
      // see. Mutation checked: dropping the `cd "$PG_ROOT"` from `pg_compose` (cwd becomes the
      // caller's).
      expect(recordOf(scratch, "compose up -d --wait postgres").cwd).toBe(
        path.resolve(REPO_ROOT),
      );
    } finally {
      await stopOpenedListener(scratch, port);
    }
  }, 30_000);

  it("fails loudly when compose reports success but nothing answers on the port", async () => {
    const scratch = mkScratch();
    // The LOB-104 case: `--wait` reports on its healthcheck, so a start whose container comes up
    // and leaves exits 0 with nothing listening. Trusting that exit code hands the caller a
    // database that is not there — `up.sh` would spend its 30-second readiness loop and leave its
    // process and pid file behind. Mutation checked: dropping the port probe back out of the
    // condition — `if ! pg_compose up -d --wait postgres >/dev/null 2>&1; then`, which is the
    // `|| ! pg_port_open` this note named before LOB-106 rewrote the compose line (the status
    // becomes 0 and the assertion below is red).
    writeFakeDocker(scratch, 0);
    const port = await closedPort();
    const result = ensurePostgres(scratch, port, {
      FAKE_DOCKER_CREATED: "faux-created",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `postgres is not up on port ${String(port)}`,
    );
    expect(result.stderr).toContain("docker compose up -d --wait postgres");
    expect(result.stdout).toBe("");
    // Compose said it started something, so the `Created` container it left is this call's to
    // remove — the same cleanup the failed-exit path does, in the same order.
    expect(subcommands(scratch)).toEqual([
      "compose up -d --wait postgres",
      "compose ps -aq --status created postgres",
      "rm -f faux-created",
    ]);
  }, 30_000);

  it("fails loudly and removes nothing when a compose that reported success left no container", async () => {
    const scratch = mkScratch();
    // Acceptance criterion 1 in full: compose exits 0 with nothing answering *and* left no
    // `Created` container, so the cleanup must ask, find nothing, and remove nothing.
    // Mutation checked: the same dropped probe as the case above (`if ! pg_compose up -d --wait
    // postgres >/dev/null 2>&1; then`) — the status is 0 and every assertion here is red.
    writeFakeDocker(scratch, 0);
    const port = await closedPort();
    const result = ensurePostgres(scratch, port);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `postgres is not up on port ${String(port)}`,
    );
    expect(result.stderr).toContain("docker compose up -d --wait postgres");
    expect(result.stdout).toBe("");
    // The whole argv, in order, and no `rm` at all: the re-probe's failure is reported from the
    // same branch as a failed exit, and a container compose never created is not this call's to
    // delete. Mutation checked: replacing `ps -aq --status created` with a bare `ps -aq` (a running
    // container would then be removed by every failed start).
    expect(subcommands(scratch)).toEqual([
      "compose up -d --wait postgres",
      "compose ps -aq --status created postgres",
    ]);
    expect(
      subcommands(scratch).filter((call) => call.startsWith("rm ")),
    ).toEqual([]);
    // Both calls address this directory's project — compose names it after the cwd.
    for (const call of composeCalls(scratch)) {
      expect(recordOf(scratch, call).cwd, call).toBe(path.resolve(REPO_ROOT));
    }
  }, 30_000);

  it(
    "fails loudly on the command to run, and removes the container a failed start created",
    { timeout: 30_000 },
    async () => {
      const scratch = mkScratch();
      writeFakeDocker(scratch, 1);
      const port = await closedPort();
      const result = ensurePostgres(scratch, port, {
        FAKE_DOCKER_CREATED: "faux-created",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `postgres is not up on port ${String(port)}`,
      );
      expect(result.stderr).toContain("docker compose up -d --wait postgres");
      // "Loudly" means one line on stderr naming the command — not a hint on stdout that a caller's
      // own output would bury, and not a bare non-zero exit. Mutation checked: `printf` without the
      // `>&2` redirection.
      expect(result.stdout).toBe("");
      expect(result.stderr.endsWith("\n")).toBe(true);
      expect(result.stderr.trimEnd().split("\n")).toHaveLength(1);
      // The exact argv, in order: nothing else may touch a container on this path.
      expect(subcommands(scratch)).toEqual([
        "compose up -d --wait postgres",
        "compose ps -aq --status created postgres",
        "rm -f faux-created",
      ]);
    },
  );

  it(
    "does not delete a container the failed start did not create",
    { timeout: 30_000 },
    async () => {
      const scratch = mkScratch();
      writeFakeDocker(scratch, 1);
      const result = ensurePostgres(scratch, await closedPort());
      expect(result.status).toBe(1);
      // A running container is someone's database and an `exited` one is not this call's to delete:
      // only `--status created` containers are removed, and there are none here. Mutation checked:
      // collapsing the cleanup's `for container in $created` loop into one unquoted
      // `pg_docker rm -f $created` — with nothing to delete, that is a stray `rm -f`.
      expect(composeCalls(scratch)).toEqual([
        "compose up -d --wait postgres",
        "compose ps -aq --status created postgres",
      ]);
      expect(
        subcommands(scratch).filter((call) => call.startsWith("rm ")),
      ).toEqual([]);
    },
  );

  it.each(UP_SCRIPTS)(
    "lets %s/up.sh start while another container holds 5442",
    async (skill) => {
      const scratch = mkScratch();
      // A docker that fails: the bug is precisely that the old `up.sh` asked it whether Postgres is
      // up. Starting the API is not what this case is about — the skill's own drive proves that — so
      // the launch and its readiness probe are stubbed with a `bun` and a `curl` that do nothing.
      writeFakeDocker(scratch, 1);
      writeFakeBunAndCurl(scratch);
      const staged = stageCaller(scratch, `.pi/skills/${skill}/up.sh`);

      const database = await answeringPort();
      try {
        const result = spawnSync("bash", [staged], {
          cwd: scratch.root,
          encoding: "utf8",
          env: childEnv(scratch, database.port),
          timeout: 30_000,
        });
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        // Mutation checked: the same one-line revert as the first case — dropping
        // `pg_port_open && return 0` from `ensure_postgres` — with `up.sh` in the position the bug
        // was reported from: another container holds the port, compose fails, and the call that
        // was supposed to be a no-op reaches docker anyway.
        expect(dockerCalls(scratch)).toEqual([]);
      } finally {
        await database.close();
      }
    },
    30_000,
  );

  it.each(UP_SCRIPTS)(
    "lets %s/up.sh start after compose really brings Postgres up",
    async (skill) => {
      const scratch = mkScratch();
      const port = await closedPort();
      // Acceptance criterion 2 at the caller, from the ralph worktree's real position: nothing
      // answers on the port, compose starts the database, and the script goes on to launch its API
      // instead of exiting 1 or waiting out its readiness loop. Mutation checked: making the
      // re-probe stricter than a TCP connect (`pg_isready`, or any check that waits for Postgres to
      // greet) — a listener that only accepts answers the port and nothing else.
      writeFakeDocker(scratch, 0, { opensPort: port });
      // The mark is deliberately late: the wait below is the assertion, not a race against a fork.
      writeMarkingBunAndReadyCurl(scratch, { markerDelayMs: 300 });
      const staged = stageCaller(scratch, `.pi/skills/${skill}/up.sh`);
      try {
        const result = spawnSync("bash", [staged], {
          cwd: scratch.root,
          encoding: "utf8",
          env: childEnv(scratch, port),
          timeout: 30_000,
        });
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(composeCalls(scratch)).toEqual([
          "compose up -d --wait postgres",
        ]);
        // "Starts normally" means the API launch really happened — not merely that the script got
        // past the precondition and its stub `curl` called every URL ready. The launch is forked, so
        // the mark arrives after the script is gone: this waits for it. Mutation checked: asserting
        // `existsSync(scratch.bunRan)` here instead — the mark is 300ms late, so that is red.
        await waitFor(
          async () => existsSync(scratch.bunRan),
          "the API launch to be recorded",
        );
      } finally {
        await stopOpenedListener(scratch, port);
      }
    },
    30_000,
  );

  it("answers on the port the compose it started opened, and on no other, then releases it", async () => {
    const scratch = mkScratch();
    const port = await closedPort();
    writeFakeDocker(scratch, 0, { opensPort: port });
    // The port refuses *before* the call, so this case is about the re-probe and not about a port
    // that happened to be open: a leftover listener would make the case below vacuous.
    expect(await doesAnswer(port)).toBe(false);
    try {
      const result = ensurePostgres(scratch, port);
      expect(result.status, result.stderr).toBe(0);
      // A start that worked: compose alone, no `ps`, no `rm`.
      expect(subcommands(scratch)).toEqual(["compose up -d --wait postgres"]);
      // The listener that fake `docker` started is the thing that answers — the re-probe's 0 is
      // attributable to it and to nothing else, because killing that pid takes the port with it.
      // It is never this process: a cleanup that killed the runner would take the suite with it.
      const pid = recordedListener(scratch);
      expect(pid).toBeDefined();
      expect(pid).not.toBe(process.pid);
      expect(pid).not.toBe(process.ppid);
      expect(isAlive(pid ?? 0)).toBe(true);
      expect(await doesAnswer(port)).toBe(true);
      // Mutation checked: dropping `opensPort` from this case (nothing answers, the status is 1),
      // and `stopOpenedListener` not killing (the port stays open and the wait below times out).
      await stopOpenedListener(scratch, port);
      expect(await doesAnswer(port)).toBe(false);
      expect(isAlive(pid ?? 0)).toBe(false);
    } finally {
      // Idempotent, and a no-op once the port refuses: the case cannot leak one either way.
      await stopOpenedListener(scratch, port);
    }
  }, 30_000);

  it(
    "defaults the port to the one compose.yaml publishes, under a caller's strict shell",
    { timeout: 30_000 },
    async () => {
      const scratch = mkScratch();
      writeFakeDocker(scratch, 0);
      // Every caller runs `set -euo pipefail`; sourcing must not need PG_PORT to be set, and the
      // default must be the host port compose.yaml maps, because that is the one the skills' own
      // DATABASE_URL points at. Mutation checked: dropping the `:-5442` default (unbound under `-u`).
      const strict = spawnSync(
        "bash",
        ["-c", 'set -euo pipefail; source "$PG_LIB"; echo "$PG_PORT"'],
        {
          cwd: scratch.root,
          encoding: "utf8",
          env: { ...envWithoutPort(scratch), PG_LIB: LIB },
          timeout: 30_000,
        },
      );
      const published = /- "(\d+):5432"/.exec(
        readFileSync(path.join(REPO_ROOT, "compose.yaml"), "utf8"),
      )?.[1];
      expect(published).toBeDefined();
      expect(strict.status, strict.stderr).toBe(0);
      expect(strict.stdout).toBe(`${String(published)}\n`);

      // `set -u` alone, the mode sigterm.sh and degraded.sh run in: an unguarded expansion anywhere
      // in the library would abort the caller before its first check.
      const nounset = spawnSync(
        "bash",
        ["-c", 'set -u; source "$PG_LIB"; echo sourced'],
        {
          cwd: scratch.root,
          encoding: "utf8",
          env: { ...envWithoutPort(scratch), PG_LIB: LIB },
          timeout: 30_000,
        },
      );
      expect(nounset.status, nounset.stderr).toBe(0);
      expect(nounset.stdout).toBe("sourced\n");
      expect(dockerCalls(scratch)).toEqual([]);
    },
  );

  it(
    "treats a port that accepts and hangs up as an answered database",
    { timeout: 30_000 },
    async () => {
      const scratch = mkScratch();
      writeFakeDocker(scratch, 1);
      const database = await hangUpPort();
      try {
        const result = ensurePostgres(scratch, database.port);
        // The precondition asks "is something listening on the session log's port", not "does it
        // speak Postgres". A probe that waits for a greeting would call compose and, in a worktree,
        // fail the bind — which is the bug this file exists for. Mutation checked: making
        // `pg_port_open` read from the socket instead of only connecting.
        expect(result.status, result.stderr).toBe(0);
        expect(dockerCalls(scratch)).toEqual([]);
      } finally {
        await database.close();
      }
    },
  );

  it(
    "names one owner when several containers publish the port, and nothing when none does",
    { timeout: 30_000 },
    async () => {
      const scratch = mkScratch();
      writeFakeDocker(scratch, 0);
      const run = (extra: Record<string, string>) =>
        spawnSync("bash", ["-c", 'source "$PG_LIB"; pg_port_owner'], {
          cwd: scratch.root,
          encoding: "utf8",
          env: { ...childEnv(scratch, 5442, extra), PG_LIB: LIB },
          timeout: 30_000,
        });

      // degraded.sh passes this straight to `docker stop`, so a two-line answer would be one
      // container name with a newline in it — nothing would stop. Mutation checked: dropping the
      // `| head -n 1`.
      const several = run({
        FAKE_DOCKER_PS: "factory-postgres-1\nanother-owner",
      });
      expect(several.status, several.stderr).toBe(0);
      expect(several.stdout).toBe("factory-postgres-1\n");

      const none = run({});
      expect(none.status, none.stderr).toBe(0);
      expect(none.stdout).toBe("");
    },
  );

  it(
    "does nothing on a second run while the port still answers",
    { timeout: 30_000 },
    async () => {
      const scratch = mkScratch();
      writeFakeDocker(scratch, 1);
      const database = await answeringPort();
      try {
        // `up.sh` twice in a row, which is what a re-run of a skill does: the second call must not
        // reach compose either. Mutation checked: the same one as the first case — removing
        // `pg_port_open && return 0` from `ensure_postgres`.
        expect(ensurePostgres(scratch, database.port).status).toBe(0);
        expect(ensurePostgres(scratch, database.port).status).toBe(0);
        expect(dockerCalls(scratch)).toEqual([]);
      } finally {
        await database.close();
      }
    },
  );

  it.each(CALLERS)(
    "lets %s refuse before it starts anything when nothing answers",
    async (caller) => {
      const scratch = mkScratch();
      writeFakeDocker(scratch, 1);
      writeMarkingBunAndReadyCurl(scratch);
      const staged = stageCaller(scratch, caller);
      const port = await closedPort();

      const result = spawnSync("bash", [staged], {
        cwd: scratch.root,
        encoding: "utf8",
        env: childEnv(scratch, port),
        timeout: 30_000,
      });
      // Acceptance criterion 2, at the caller: with Postgres genuinely stopped the script stops,
      // names the command to run, and has not launched an API or touched a container.
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      expect(result.stderr).toContain(
        `postgres is not up on port ${String(port)}`,
      );
      expect(result.stderr).toContain("docker compose up -d --wait postgres");
      expect(existsSync(scratch.bunRan)).toBe(false);
      // Mutation checked: `return 0` on the library's failure path (a caller would launch against a
      // database that is not there), and dropping `|| exit 1` from degraded.sh or sigterm.sh, which
      // run without `set -e` and would otherwise carry on.
      expect(subcommands(scratch)).toEqual([
        "compose up -d --wait postgres",
        "compose ps -aq --status created postgres",
      ]);
    },
    30_000,
  );

  it.each(UP_SCRIPTS)(
    "lets %s/up.sh refuse when its compose reported success and nothing answers",
    async (skill) => {
      const scratch = mkScratch();
      // LOB-104's failure at the caller, verbatim: compose reports success and nothing answers. The
      // pre-fix script went on to launch an API against a database that is not there, spent its
      // 30-second `/readyz` loop, exited 1 with `api.pid` written and the process still up — so the
      // next `up.sh` refused with "already running". With the re-probe it stops before any of that.
      // Mutation checked: the same dropped port probe (`if ! pg_compose up -d --wait postgres
      // >/dev/null 2>&1; then`) — the launcher runs (`bunRan`), the pid file appears, and the status
      // is 0 instead of 1, so three assertions here go red.
      writeFakeDocker(scratch, 0);
      writeMarkingBunAndReadyCurl(scratch);
      const staged = stageCaller(scratch, `.pi/skills/${skill}/up.sh`);
      const port = await closedPort();
      const result = spawnSync("bash", [staged], {
        cwd: scratch.root,
        encoding: "utf8",
        env: childEnv(scratch, port, { FAKE_DOCKER_CREATED: "faux-created" }),
        timeout: 30_000,
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      expect(result.stderr).toContain(
        `postgres is not up on port ${String(port)}`,
      );
      expect(result.stderr).toContain("docker compose up -d --wait postgres");
      // No process was launched, and no pid file was left for the next run to refuse on. The run
      // directory exists — `up.sh` makes it before the precondition — so the absence is the pid
      // file and not a directory that was never created.
      expect(existsSync(scratch.bunRan)).toBe(false);
      const runDir = path.join(scratch.root, ".verify/run");
      expect(existsSync(runDir)).toBe(true);
      expect(existsSync(path.join(runDir, "api.pid"))).toBe(false);
      // And the `Created` container left by this start is still removed, as on a failed exit.
      expect(subcommands(scratch)).toEqual([
        "compose up -d --wait postgres",
        "compose ps -aq --status created postgres",
        "rm -f faux-created",
      ]);
    },
    30_000,
  );

  it("defers to the port when its own compose failed but the port answers by then", async () => {
    const scratch = mkScratch();
    const port = await closedPort();
    // The race a worktree can lose: the port looked free, someone else's `compose up` bound it
    // first, and this call's compose failed with "port is already allocated" — while a database now
    // answers on the very port every caller needs. LOB-106: a failed compose is not this call's to
    // report, because the one claim a caller depends on — "is there a database on 5442" — is true,
    // and refusing would print a command that now fails too. The port decides, in both directions.
    // Mutation checked: putting the failure back in charge, i.e. the shipped line reverting to
    // `if ! pg_compose up -d --wait postgres >/dev/null 2>&1 || ! pg_port_open` — the status becomes
    // 1, the refusal appears on stderr, and the `Created` cleanup runs.
    writeFakeDocker(scratch, 1, { opensPort: port });
    try {
      const result = ensurePostgres(scratch, port);
      expect(await doesAnswer(port)).toBe(true);
      expect(result.status, result.stderr).toBe(0);
      // Silent, like every other success: a caller's own output is the only thing on the terminal.
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      // Nothing this project did not create is touched, and the healthy database is left exactly as
      // it was found: no `ps`, no `rm`, and no second compose attempt.
      expect(subcommands(scratch)).toEqual(["compose up -d --wait postgres"]);
    } finally {
      await stopOpenedListener(scratch, port);
    }
  }, 30_000);

  it("survives its own failed compose in a caller that runs `set -euo pipefail` without guarding the call", async () => {
    const scratch = mkScratch();
    const port = await closedPort();
    // The other half of the LOB-106 line, and the reason compose's exit code is *discarded* rather
    // than ignored: the library sets no shell options and states that "the caller owns `set -euo
    // pipefail`" (`.pi/skills/lib/postgres.sh`, header). Every caller today writes
    // `ensure_postgres || exit 1`, and bash ignores `-e` inside a function called in an `||` list or
    // in an `if` condition — so for those five callers the `|| true` is defence, not a live fix. For
    // a caller that calls it bare, it is the whole fix: without it the failing compose aborts the
    // shell at the compose line, before the port is ever asked, and LOB-106's refusal comes back one
    // layer down with the exit status of a `docker compose up`.
    // Mutation checked: dropping `|| true` from the compose line. This is the only case that
    // mutation reddens (dropping it alone left 39 of 40 green) — no other case in this file pins it.
    // The marker avoids `port:` followed by a digit on purpose: the case further down that guards
    // this file's own connections reads them out of its own source, and that pattern is one of its
    // assertions.
    writeFakeDocker(scratch, 1, { opensPort: port });
    try {
      const strict = spawnSync(
        "bash",
        [
          "-c",
          'set -euo pipefail; source "$PG_LIB"; ensure_postgres; echo "the port was asked, status $?"',
        ],
        {
          cwd: scratch.root,
          encoding: "utf8",
          env: { ...childEnv(scratch, port), PG_LIB: LIB },
          timeout: 30_000,
        },
      );
      // The line after the call ran, so the shell was not aborted by the compose failure — and the
      // status it read is 0, because the port answers.
      expect(strict.status, strict.stderr).toBe(0);
      expect(strict.stdout).toBe("the port was asked, status 0\n");
      expect(await doesAnswer(port)).toBe(true);
      // Reached by asking the port, and the database the failed compose did not start is untouched.
      expect(subcommands(scratch)).toEqual(["compose up -d --wait postgres"]);
    } finally {
      await stopOpenedListener(scratch, port);
    }
  }, 30_000);

  it.each(UP_SCRIPTS)(
    "lets %s/up.sh start after a compose that failed while another agent took the port",
    async (skill) => {
      const scratch = mkScratch();
      const port = await closedPort();
      // LOB-106 at the caller, from the ralph worktree's real position: the port was free when the
      // precondition probed it, another agent's `compose up` bound 5442 in the window, and this
      // call's compose exited 1 with "port is already allocated". The database every caller needs is
      // up, so `up.sh` must go on to launch its API rather than refuse and leave `api.pid` unwritten.
      // Mutation checked: the same one-line revert as the library case above — status 1, no launch
      // mark, and the refusal naming a command that would fail.
      writeFakeDocker(scratch, 1, { opensPort: port });
      // The mark is deliberately late, so the wait below is the assertion rather than a race.
      writeMarkingBunAndReadyCurl(scratch, { markerDelayMs: 300 });
      const staged = stageCaller(scratch, `.pi/skills/${skill}/up.sh`);
      try {
        const result = spawnSync("bash", [staged], {
          cwd: scratch.root,
          encoding: "utf8",
          env: childEnv(scratch, port),
          timeout: 30_000,
        });
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        // One attempt, and no cleanup of a container that is not this call's: the port answers.
        expect(composeCalls(scratch)).toEqual([
          "compose up -d --wait postgres",
        ]);
        await waitFor(
          async () => existsSync(scratch.bunRan),
          "the API launch to be recorded",
        );
      } finally {
        await stopOpenedListener(scratch, port);
      }
    },
    30_000,
  );

  it(
    "lets degraded.sh refuse loudly when the port answers but no container publishes it",
    { timeout: 30_000 },
    async () => {
      const scratch = mkScratch();
      // No `FAKE_DOCKER_PS`: the port is served by something docker does not know about — a native
      // server, a tunnel, or a container another daemon owns. `degraded.sh` cannot take that database
      // away and give it back, so it must say so instead of stopping the wrong thing.
      writeFakeDocker(scratch, 0);
      writeMarkingBunAndReadyCurl(scratch);
      const staged = stageCaller(scratch, ".pi/skills/verify-api/degraded.sh");
      const database = await answeringPort();
      try {
        const result = spawnSync("bash", [staged], {
          cwd: scratch.root,
          encoding: "utf8",
          env: childEnv(scratch, database.port),
          timeout: 30_000,
        });
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
        expect(result.stderr).toContain(
          `port ${String(database.port)} answers but no container publishes it`,
        );
        expect(existsSync(scratch.bunRan)).toBe(false);
        // The refusal happens before the trap is armed, so nothing is stopped, started or removed.
        // Mutation checked: dropping the `[ -z "$PG_CONTAINER" ]` guard (a `docker stop ""` appears).
        expect(subcommands(scratch)).toEqual([
          `ps --filter publish=${String(database.port)} --format {{.Names}}`,
        ]);
      } finally {
        await database.close();
      }
    },
  );

  it("stops the container that publishes the port and starts it again, by name", async () => {
    const scratch = mkScratch();
    const state = path.join(scratch.root, "docker-state.txt");
    writeFileSync(state, "running");
    writeFakeDocker(scratch, 0);
    writeLongLivedApiBunAndReadyCurl(scratch);
    const staged = stageCaller(scratch, ".pi/skills/verify-api/degraded.sh");
    const database = await answeringPort();
    try {
      const result = spawnSync("bash", [staged], {
        cwd: scratch.root,
        encoding: "utf8",
        env: childEnv(scratch, database.port, {
          FAKE_DOCKER_PS: "factory-postgres-1",
          FAKE_DOCKER_STATE: state,
        }),
        timeout: 30_000,
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const calls = subcommands(scratch);
      // The container is named, and it is the one publishing the port under test — not whatever
      // compose would call it from this directory (the pre-fix bug). Mutation checked: swapping
      // `pg_port_owner` for a hard-coded `factory-postgres-1`, and `pg_docker stop` for
      // `pg_docker stop "$PG_PORT"`.
      expect(calls).toContain("stop factory-postgres-1");
      expect(calls).toContain("start factory-postgres-1");
      // The stop is the test; the start is putting the database back, and `degraded.sh` does it
      // twice — the `EXIT` trap and an explicit call after the API launch — so dropping either one
      // alone is silent. The pair is the assertion: the database comes back, after the stop.
      // Mutation checked: neutering `postgres_up` in `degraded.sh` (`pg_docker start "$PG_CONTAINER"`
      // → `:`), so no start call is recorded at all and the `start` assertion above goes red.
      expect(calls.indexOf("stop factory-postgres-1")).toBeLessThan(
        calls.indexOf("start factory-postgres-1"),
      );
      // Nothing on this path may touch the shared container on 5442: `PG_PORT` decides what is
      // stopped, and every check passed, so the database was restored.
      for (const call of calls) expect(call, call).not.toContain("5442");
      expect(readFileSync(state, "utf8")).toBe("running");
    } finally {
      await database.close();
    }
  }, 30_000);

  it("falls back to colima's socket when the active context cannot answer", async () => {
    const scratch = mkScratch();
    const home = await colimaHome();
    const port = await closedPort();
    // `docker info` fails the way a stopped Docker Desktop does; colima's socket is there, and the
    // compose that runs on it really brings the database up — the re-probe would refuse otherwise.
    writeFakeDocker(scratch, 0, { infoExit: 1, opensPort: port });
    try {
      const result = ensurePostgres(scratch, port, {
        HOME: home.home,
        DOCKER_HOST: "",
      });
      expect(result.status, result.stderr).toBe(0);
      // Mutation checked: neutering colima's `export DOCKER_HOST=…` line (`:` in its place) — the
      // fallback stops switching sockets, and a machine whose active context is a stopped Docker
      // Desktop keeps failing every call.
      expect(
        recordOf(scratch, "compose up -d --wait postgres").dockerHost,
      ).toBe(`unix://${home.socket}`);
      // Resolved once, then kept: the probe is a docker call of its own, and paying it before every
      // call would be a probe per docker invocation.
      expect(
        dockerCalls(scratch).filter((call) => call === "info"),
      ).toHaveLength(1);
    } finally {
      await home.close();
      await stopOpenedListener(scratch, port);
    }
  }, 30_000);

  it("leaves DOCKER_HOST alone when the active context answers", async () => {
    const scratch = mkScratch();
    const home = await colimaHome();
    const port = await closedPort();
    writeFakeDocker(scratch, 0, { infoExit: 0, opensPort: port });
    try {
      const result = ensurePostgres(scratch, port, {
        HOME: home.home,
        DOCKER_HOST: "",
      });
      expect(result.status, result.stderr).toBe(0);
      // Mutation checked: dropping the `! docker info` condition (colima's socket would be forced
      // on a machine whose active context is fine).
      expect(
        recordOf(scratch, "compose up -d --wait postgres").dockerHost,
      ).toBe("<unset>");
    } finally {
      await home.close();
      await stopOpenedListener(scratch, port);
    }
  }, 30_000);

  it("never second-guesses an explicit DOCKER_HOST", async () => {
    const scratch = mkScratch();
    const home = await colimaHome();
    const port = await closedPort();
    writeFakeDocker(scratch, 0, { infoExit: 1, opensPort: port });
    try {
      const result = ensurePostgres(scratch, port, {
        HOME: home.home,
        DOCKER_HOST: "unix:///var/run/docker.sock",
      });
      expect(result.status, result.stderr).toBe(0);
      // Mutation checked: dropping the `[ -z "${DOCKER_HOST:-}" ]` condition from `pg_docker`
      // (LOB-105's guard) — the fallback overwrites the socket the caller chose.
      expect(
        recordOf(scratch, "compose up -d --wait postgres").dockerHost,
      ).toBe("unix:///var/run/docker.sock");
      // An explicit socket wins, so there is nothing to probe for.
      expect(dockerCalls(scratch)).not.toContain("info");
    } finally {
      await home.close();
      await stopOpenedListener(scratch, port);
    }
  }, 30_000);

  it(
    "drives docker only through the shim on PATH, and starts nothing but its own runtime",
    { timeout: 30_000 },
    async () => {
      const scratch = mkScratch();
      const port = await closedPort();
      writeFakeDocker(scratch, 0, { opensPort: port });

      // 1. The shim is what every child of this file resolves `docker` to. A call through an absolute
      //    path or a login shell would bypass it and read as "docker was never called" — a false green
      //    for every case above, and a real daemon behind the ones that assert it was never reached.
      const resolved = spawnSync("bash", ["-c", "command -v docker || true"], {
        cwd: scratch.root,
        encoding: "utf8",
        env: childEnv(scratch, port),
        timeout: 30_000,
      });
      expect(resolved.stdout.trim()).toBe(path.join(scratch.bin, "docker"));
      expect(
        childEnv(scratch, port)["PATH"]?.startsWith(
          `${scratch.bin}${path.delimiter}`,
        ),
      ).toBe(true);

      // 2. A text guard on the shape of the fake, not a behavioural one: it can only fail if these
      //    constants are edited, and it is here to keep them edited together. What it is worth is that
      //    the shim starts the runtime running this suite on one file rather than a `node` looked up
      //    on `PATH` or a shell one-liner. The *clients* in this file are pinned to loopback by the
      //    cases that connect; the listener's own bind address is guarded here, because a listener on
      //    `0.0.0.0` would answer those same connections just as well.
      const shim = readFileSync(path.join(scratch.bin, "docker"), "utf8");
      expect(shim).toContain(process.execPath);
      const listener = readFileSync(
        path.join(scratch.root, "listener.cjs"),
        "utf8",
      );
      expect(listener).toContain('require("node:net")');
      expect(listener).toContain(
        'server.listen(Number(process.argv[2]), "127.0.0.1")',
      );
      expect(listener).not.toContain("0.0.0.0");

      // 3. The helper itself names the CLI in exactly two places, both inside `pg_docker` — the
      //    function that owns the colima fallback. Anywhere else in the file is a call the cases could
      //    not drive, and a call that skipped the fallback. Mutation checked: adding a `docker ps ...`
      //    beside `pg_port_open`.
      const helper = readFileSync(LIB, "utf8");
      const code = helper
        .split("\n")
        .filter((line) => !/^\s*#/.test(line))
        .join("\n")
        .replace(/'[^']*'/g, "''")
        .replace(/"[^"]*"/g, '""');
      const pgDocker = code.slice(
        code.indexOf("pg_docker() {"),
        code.indexOf("}", code.indexOf("pg_docker() {")),
      );
      expect(code.match(/\bdocker\b/g)).toHaveLength(2);
      expect(pgDocker.match(/\bdocker\b/g)).toHaveLength(2);
      // The probe is loopback on the overridable port: never a host name, never every interface.
      // `${PG_PORT}` counts as well as `$PG_PORT` — the property is the address, not the spelling.
      const noComments = helper
        .split("\n")
        .filter((line) => !/^\s*#/.test(line))
        .join("\n");
      expect(noComments).toMatch(/\/dev\/tcp\/127\.0\.0\.1\/\$\{?PG_PORT\}?/);
      expect(noComments).not.toMatch(/localhost|0\.0\.0\.0/);

      // 4. And this file's own connections go to ports it started or proved closed: no `host:port`
      //    literal to inherit a real service by accident, and no URL at all. The literal 5442 in the
      //    `pg_port_owner` case feeds `docker ps --filter`, which opens no socket.
      const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
      expect(self).not.toMatch(/https?:\/\//);
      expect(self).not.toMatch(/port:\s*\d/);
    },
  );

  it("leaves the listener alone when there is none, and never signals a malformed pid", async () => {
    const scratch = mkScratch();
    // The `finally` in the cases above runs on paths whose compose never reported success, so there
    // is no listener to stop and nothing to wait for.
    writeFakeDocker(scratch, 1);
    const port = await closedPort();
    await stopOpenedListener(scratch, port);
    expect(existsSync(scratch.listenerPid)).toBe(false);

    // A truncated or corrupted record must not reach `process.kill`: 0 signals this process's whole
    // group (this suite included) and -1 every process the user owns, so only a positive integer is
    // treated as a listener. This case survives those records; a `<= 0` guard that loosened would
    // not be an assertion failure here but a dead runner, which is why the values are exercised.
    // Mutation checked: dropping the `pid > 0` guard from `recordedListener` — `kill -1` takes the
    // suite and the shell that started it with it.
    for (const malformed of ["", "0", "-1", "12 34\n", "not-a-pid\n"]) {
      writeFileSync(scratch.listenerPid, malformed);
      await stopOpenedListener(scratch, port);
    }
    expect(isAlive(process.pid)).toBe(true);

    // A listener that is already gone — the case where the compose it belonged to exited long
    // after the port was opened by someone else. `process.kill` throws, and the wait still passes
    // instead of failing the case that cleaned up correctly.
    const exited = spawnSync("true", { encoding: "utf8" });
    const deadPid = exited.pid ?? 0;
    expect(deadPid).toBeGreaterThan(0);
    if (!isAlive(deadPid)) {
      writeFileSync(scratch.listenerPid, String(deadPid));
      await stopOpenedListener(scratch, port);
    }
  }, 30_000);

  it(
    "keeps the compose call inside the one helper the callers share",
    { timeout: 30_000 },
    () => {
      // The bug existed in five copies of the same stanza. This is the drift guard: a new `up.sh`
      // that copy-pastes `docker compose up` re-introduces it, and the cases above would not see a
      // script they are not told about. Mutation checked: adding `docker compose up -d --wait
      // postgres` to any caller below, under whatever name it is sourced as.
      for (const caller of CALLERS) {
        const source = readFileSync(path.join(REPO_ROOT, caller), "utf8");
        expect(source, caller).toContain(".pi/skills/lib/postgres.sh");
        expect(source, caller).not.toContain("docker compose up");
      }
    },
  );

  it(
    "reaches docker nowhere but through the helper and the library",
    { timeout: 30_000 },
    () => {
      // `not.toContain("docker compose up")` above misses `docker  compose up`, `pg_docker compose
      // up` and `docker ps`. Strip the comments and the quoted strings — a message that mentions
      // docker is not a call — and no caller may name the CLI at all: everything goes through
      // `pg_docker`/`pg_compose`, which the cases above drive.
      // Mutation checked: adding `pg_docker compose up -d --wait postgres` to any caller.
      for (const caller of CALLERS) {
        const code = readFileSync(path.join(REPO_ROOT, caller), "utf8")
          .split("\n")
          .filter((line) => !/^\s*#/.test(line))
          .join("\n")
          .replace(/'[^']*'/g, "''")
          .replace(/"[^"]*"/g, '""');
        expect(code, caller).not.toMatch(/\bdocker\b/);
        expect(code, caller).not.toMatch(/(^|[^_\w])compose\b/);
      }
    },
  );

  it(
    "leaves no case unaccounted for in the mutation note every case carries",
    { timeout: 30_000 },
    () => {
      // The header's claim is a property of this file, so it is checked like one: a case declares
      // itself on a line that starts with `it(` or `test(`, and its mutation note is a comment line
      // inside it. The scan is structural — a note anywhere between two declarations belongs to the
      // earlier one — because a hand-kept list of exceptions in the header is exactly what drifted
      // (LOB-107, six cases). Mutation checked: deleting every `Mutation checked:` line a case
      // carries, whose case then appears in `unaccounted` — this case included, since its own note is
      // the only place the marker is written inside it.
      const lines = readFileSync(fileURLToPath(import.meta.url), "utf8").split(
        "\n",
      );
      // Vitest's modifiers included, in both spellings: `it.each(UP_SCRIPTS)(` and
      // `it.skip("name", fn)` both declare a case that carries a note like any other, and neither is
      // a case the scan may walk past. `it.todo` counts too — it has no assertion, so it has no
      // mutation to name, and the honest answer is a red guard rather than a silent exemption.
      const declarations = lines.flatMap((line, index) =>
        /^\s*(?:it|test)(?:\.[\w$]+(?:\([^)]*\))?)*\(/.test(line)
          ? [index]
          : [],
      );
      // A scan that stopped finding declarations would leave nothing to check and pass vacuously.
      // The count is a tripwire, not an invariant: bump the 28 when a case is added, and give the new
      // case its note.
      expect(
        declarations,
        "declaration count changed — bump the 29 and keep every case's mutation note",
      ).toHaveLength(29);
      const unaccounted = declarations.filter((start, position) => {
        const end = declarations[position + 1] ?? lines.length;
        return !lines.slice(start, end).some(isMutationNote);
      });
      expect(unaccounted.map((index) => lines[index]?.trim())).toEqual([]);
    },
  );

  it(
    "gives every case a budget, so none relies on vitest's 5 s default",
    { timeout: 30_000 },
    () => {
      // Mutation checked: deleting the `timeout: 30_000` from this case's own options makes
      // the guard below redden with this case's line number.
      // Mutation: delete `{ timeout: 30_000 },` from any case above — the guard reads the file
      // back and fails, naming the case that lost its budget. Without this case a future edit
      // could silently drop a budget and the gate would go red intermittently under parallel
      // load, which is the failure this issue exists to prevent.
      //
      // The guard enforces this file's convention — a per-case `{ timeout }` option or a
      // trailing `, 30_000)` argument — not the only possible way to budget a case. A future
      // `test.timeout` in `vitest.config.ts` would be a legitimate fix that this guard does
      // not recognise; that is a limitation to note, not a false green today (the config sets
      // no timeout).
      const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
      const lines = source.split("\n");
      const declarations = lines.flatMap((line, index) =>
        /^\s*(?:it|test)(?:\.[\w$]+(?:\([^)]*\))?)*\(/.test(line)
          ? [index]
          : [],
      );
      const missing: string[] = [];
      for (let position = 0; position < declarations.length; position++) {
        const start = declarations[position]!;
        const end = declarations[position + 1] ?? lines.length;
        const caseLines = lines.slice(start, end);
        // Vitest timeout in this file appears as either:
        // - `{ timeout: 30_000 }` as the second argument (on the `it(` line or next line)
        // - `, 30_000)` as the last argument (at the end of the test case)
        const hasTimeout = caseLines.some(
          (candidate) =>
            /\btimeout\s*:\s*30_000\b/.test(candidate) ||
            /,\s*30_000\s*[)}]\s*;?\s*$/.test(candidate),
        );
        if (!hasTimeout) {
          missing.push(`line ${String(start + 1)}: ${lines[start]!.trim()}`);
        }
      }
      expect(missing).toEqual([]);
    },
  );
});
