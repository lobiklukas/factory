import { spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * `verify-board`'s `doctor.sh` fails loudly when Postgres is down rather than skipping (LOB-84).
 *
 * The board is rows, so a doctor that said OK while the database was down would hand a drive a
 * control plane whose every read is an error. These cases run the real script, copied into a
 * scratch repo layout so its `.verify/run` is the scratch's, against a real TCP listener standing in
 * for a database that answers and a released port standing in for one that does not. The port comes
 * from `DATABASE_URL`, as `up.sh` hands it to the API, so no case depends on — or touches — 5442.
 *
 * Everything else the doctor asks about (the API's pid and port, `/readyz`, the dashboard, tmux) is
 * answered by fakes on `PATH` and live pids, so that one case can make the database the *only*
 * thing wrong: an exit code that is non-zero for some other reason proves nothing about the check.
 *
 * Lives in `@repo/storage-postgres` beside `postgres-up.test.ts`, for the same reason: it is a
 * repo-level Postgres claim that belongs to no package, and it needs no database to run. Each case
 * names the mutation it was checked against on a `// Mutation checked:` line.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const DOCTOR = ".pi/skills/verify-board/doctor.sh";

const created: string[] = [];
afterAll(() => {
  for (const root of created) rmSync(root, { recursive: true, force: true });
});

/** A listener that answers for the duration of one case, standing in for a healthy database. */
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

const doesAnswer = async (port: number): Promise<boolean> => {
  const socket = createConnection({ port, host: "127.0.0.1" });
  try {
    await once(socket, "connect");
    socket.destroy();
    return true;
  } catch {
    socket.destroy();
    return false;
  }
};

/** A port nothing answers on: taken, released, and confirmed to refuse. */
const closedPort = async (): Promise<number> => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const released = await answeringPort();
    await released.close();
    if (!(await doesAnswer(released.port))) return released.port;
  }
  throw new Error("no closed port was available");
};

const writeExecutable = (file: string, body: string): void => {
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(file, 0o755);
};

/**
 * A scratch repo holding only the doctor. With `healthy`, everything but the database is as
 * `./up.sh` leaves it: recorded api and web pids that are alive (this test process), an `lsof` that
 * names the api pid as the port's owner, a `curl` that reads 200, a `tmux`, and a seeded board.
 */
const stage = (
  healthy: boolean,
  options: { readonly webPortOwner?: string } = {},
): { root: string; bin: string } => {
  const root = mkdtempSync(path.join(tmpdir(), "factory-verify-board-doctor-"));
  created.push(root);
  const staged = path.join(root, DOCTOR);
  mkdirSync(path.dirname(staged), { recursive: true });
  cpSync(path.join(REPO_ROOT, DOCTOR), staged);
  const bin = path.join(root, "bin");
  mkdirSync(bin, { recursive: true });
  if (healthy) {
    const run = path.join(root, ".verify/run");
    mkdirSync(run, { recursive: true });
    const pid = String(process.pid);
    writeFileSync(path.join(run, "api.pid"), pid);
    writeFileSync(path.join(run, "web.pid"), pid);
    writeFileSync(path.join(run, "board.json"), '{"boardId":"brd_scratch"}\n');
    // The dashboard's port (3400: the test unsets WEB_PORT and stages no `web-port`) can be
    // answered by a different owner than the API's, standing in for a stranger holding it.
    const webOwner = options.webPortOwner ?? pid;
    writeExecutable(
      path.join(bin, "lsof"),
      [
        `case "$*" in`,
        `  *TCP:3400*) printf 'COMMAND PID\\nnode ${webOwner}\\n' ;;`,
        `  *) printf 'COMMAND PID\\nbun ${pid}\\n' ;;`,
        `esac`,
      ].join("\n"),
    );
    writeExecutable(path.join(bin, "curl"), "printf 200");
    writeExecutable(path.join(bin, "tmux"), "echo 'tmux 3.4'");
  }
  return { root, bin };
};

const runDoctor = (bin: string, root: string, pgPort: number) => {
  // `Object.entries`, not `process.env["NAME"]`: the repo's Effect lint reads a direct property
  // access as configuration, and a test inheriting the shell's environment configures nothing.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete inherited["PG_PORT"];
  delete inherited["WEB_PORT"];
  delete inherited["API_PORT"];
  return spawnSync("bash", [path.join(root, DOCTOR)], {
    encoding: "utf8",
    timeout: 20_000,
    env: {
      ...inherited,
      PATH: `${bin}${path.delimiter}${inherited["PATH"] ?? ""}`,
      DATABASE_URL: `postgres://factory:factory@localhost:${String(pgPort)}/factory_doctor`,
    },
  });
};

describe("verify-board's doctor and the database", () => {
  it(
    "says OK when Postgres answers and the instance is healthy (the control)",
    { timeout: 30_000 },
    async () => {
      // Mutation checked: probing a hard-coded 5442 instead of the DATABASE_URL port makes this
      // case red wherever nothing listens on 5442, and a doctor that failed its database check
      // unconditionally reddens it everywhere — without it, the next case could pass vacuously.
      const { root, bin } = stage(true);
      const database = await answeringPort();
      try {
        const result = runDoctor(bin, root, database.port);
        expect(result.stdout).toContain(`postgres :${String(database.port)}:`);
        expect(result.stdout).toMatch(/accepting connections/);
        expect(result.stdout).toContain("doctor: OK");
        expect(result.status).toBe(0);
      } finally {
        await database.close();
      }
    },
  );

  it(
    "fails, loudly, when Postgres is the only thing down",
    { timeout: 30_000 },
    async () => {
      // Mutation checked: dropping `fail=1` from the DOWN branch makes the doctor exit 0 here,
      // because the database is the one thing this case makes wrong; dropping the stderr line
      // reddens the `stderr` assertion.
      const { root, bin } = stage(true);
      const port = await closedPort();
      const result = runDoctor(bin, root, port);
      expect(result.stdout).toMatch(
        new RegExp(`postgres :${String(port)}:\\s+DOWN`),
      );
      expect(result.stderr).toContain(
        `doctor: Postgres on :${String(port)} is DOWN`,
      );
      expect(result.stdout).not.toContain("doctor: OK");
      expect(result.status).toBe(1);
    },
  );

  it(
    "fails when a stranger owns the dashboard's port, even though it answers",
    { timeout: 30_000 },
    async () => {
      // Mutation checked: dropping the `is_ours` check on WEB_PORT — leaving only "the web pid is
      // alive and the port answers 200" — makes the doctor say OK here, because the recorded web
      // pid is alive (this test process) and the fake `curl` answers 200; only the owner is wrong.
      // pid 1 is never a descendant of the recorded pid, so it stands in for the stranger.
      const { root, bin } = stage(true, { webPortOwner: "1" });
      const database = await answeringPort();
      try {
        const result = runDoctor(bin, root, database.port);
        expect(result.stdout).toMatch(/web port 3400:\s+owned by 1, not under/);
        expect(result.stdout).not.toContain("doctor: OK");
        expect(result.status).toBe(1);
      } finally {
        await database.close();
      }
    },
  );

  it(
    "still reports the database when no instance was ever started",
    { timeout: 30_000 },
    async () => {
      // Mutation checked: restoring the early `exit 1` on a missing `api.pid` — which ran before
      // the database check, so a down Postgres was never mentioned — makes the DOWN line vanish.
      const { root, bin } = stage(false);
      const port = await closedPort();
      const result = runDoctor(bin, root, port);
      expect(result.stdout).toContain("api pid:");
      expect(result.stdout).toMatch(
        new RegExp(`postgres :${String(port)}:\\s+DOWN`),
      );
      expect(result.status).toBe(1);
    },
  );
});
