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
 * The file lives in `@repo/storage-postgres` for the same reason `turbo-env.test.ts` does: it is a
 * repo-level Postgres claim that belongs to no package, and it needs no database to run.
 *
 * Each case below names the mutation it was checked against — the one-line change that makes it go
 * red. A case whose mutation nobody can state is not testing anything.
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

interface Scratch {
  readonly root: string;
  readonly bin: string;
  readonly dockerCalls: string;
  readonly dockerDetail: string;
  readonly bunRan: string;
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
  };
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
  options: { readonly infoExit?: number } = {},
): void => {
  const file = path.join(scratch.bin, "docker");
  const calls = JSON.stringify(scratch.dockerCalls);
  const detail = JSON.stringify(scratch.dockerDetail);
  writeFileSync(
    file,
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> ${calls}`,
      `printf 'argv=%s\\tcwd=%s\\tdocker_host=%s\\n' "$*" "$PWD" "\${DOCKER_HOST:-<unset>}" >> ${detail}`,
      'case "$*" in',
      `  info) exit ${String(options.infoExit ?? 0)} ;;`,
      `  *"compose up"*) exit ${String(upExit)} ;;`,
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
 */
const writeMarkingBunAndReadyCurl = (scratch: Scratch): void => {
  const bun = path.join(scratch.bin, "bun");
  writeFileSync(
    bun,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(scratch.bunRan)}\nexit 0\n`,
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
  it("leaves a database that already answers alone, without calling docker", async () => {
    const scratch = mkScratch();
    writeFakeDocker(scratch, 1);
    const database = await answeringPort();
    try {
      const result = ensurePostgres(scratch, database.port);
      expect(result.status, result.stderr).toBe(0);
      expect(dockerCalls(scratch)).toEqual([]);
      // The helper is silent on the path every skill takes on a developer machine.
      expect(result.stdout).toBe("");
    } finally {
      await database.close();
    }
  });

  it("starts Postgres with compose when nothing answers on the port", async () => {
    const scratch = mkScratch();
    writeFakeDocker(scratch, 0);
    const result = ensurePostgres(scratch, await closedPort());
    expect(result.status, result.stderr).toBe(0);
    expect(composeCalls(scratch)).toEqual(["compose up -d --wait postgres"]);
    // Compose names its project after the directory it runs in, so the call has to happen from the
    // root the helper belongs to: from anywhere else it addresses a project nobody else can see.
    // Mutation checked: dropping the `cd "$PG_ROOT"` from `pg_compose` (cwd becomes the caller's).
    expect(recordOf(scratch, "compose up -d --wait postgres").cwd).toBe(
      path.resolve(REPO_ROOT),
    );
  });

  it("fails loudly on the command to run, and removes the container a failed start created", async () => {
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
  });

  it("does not delete a container the failed start did not create", async () => {
    const scratch = mkScratch();
    writeFakeDocker(scratch, 1);
    const result = ensurePostgres(scratch, await closedPort());
    expect(result.status).toBe(1);
    // A running container is someone's database and an `exited` one is not this call's to delete:
    // only `--status created` containers are removed, and there are none here.
    expect(composeCalls(scratch)).toEqual([
      "compose up -d --wait postgres",
      "compose ps -aq --status created postgres",
    ]);
    expect(
      subcommands(scratch).filter((call) => call.startsWith("rm ")),
    ).toEqual([]);
  });

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
        expect(dockerCalls(scratch)).toEqual([]);
      } finally {
        await database.close();
      }
    },
    30_000,
  );

  it("defaults the port to the one compose.yaml publishes, under a caller's strict shell", async () => {
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
  });

  it("treats a port that accepts and hangs up as an answered database", async () => {
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
  });

  it("names one owner when several containers publish the port, and nothing when none does", async () => {
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
  });

  it("does nothing on a second run while the port still answers", async () => {
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
  });

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

  it("lets degraded.sh refuse loudly when the port answers but no container publishes it", async () => {
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
  });

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
      // The stop is the test; the start is the `EXIT` trap putting the database back. A trap that
      // forgot the second half leaves someone's database down, so the order is the assertion.
      // Mutation checked: dropping `postgres_up` from the trap.
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
    // `docker info` fails the way a stopped Docker Desktop does; colima's socket is there.
    writeFakeDocker(scratch, 0, { infoExit: 1 });
    try {
      const result = ensurePostgres(scratch, await closedPort(), {
        HOME: home.home,
        DOCKER_HOST: "",
      });
      expect(result.status, result.stderr).toBe(0);
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
    }
  });

  it("leaves DOCKER_HOST alone when the active context answers", async () => {
    const scratch = mkScratch();
    const home = await colimaHome();
    writeFakeDocker(scratch, 0, { infoExit: 0 });
    try {
      const result = ensurePostgres(scratch, await closedPort(), {
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
    }
  });

  it("never second-guesses an explicit DOCKER_HOST", async () => {
    const scratch = mkScratch();
    const home = await colimaHome();
    writeFakeDocker(scratch, 0, { infoExit: 1 });
    try {
      const result = ensurePostgres(scratch, await closedPort(), {
        HOME: home.home,
        DOCKER_HOST: "unix:///var/run/docker.sock",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(
        recordOf(scratch, "compose up -d --wait postgres").dockerHost,
      ).toBe("unix:///var/run/docker.sock");
      // An explicit socket wins, so there is nothing to probe for.
      expect(dockerCalls(scratch)).not.toContain("info");
    } finally {
      await home.close();
    }
  });

  it("keeps the compose call inside the one helper the callers share", () => {
    // The bug existed in five copies of the same stanza. This is the drift guard: a new `up.sh`
    // that copy-pastes `docker compose up` re-introduces it, and the cases above would not see a
    // script they are not told about.
    for (const caller of CALLERS) {
      const source = readFileSync(path.join(REPO_ROOT, caller), "utf8");
      expect(source, caller).toContain(".pi/skills/lib/postgres.sh");
      expect(source, caller).not.toContain("docker compose up");
    }
  });

  it("reaches docker nowhere but through the helper and the library", () => {
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
  });
});
