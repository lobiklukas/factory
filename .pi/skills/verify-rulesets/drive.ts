// The GitHub rulesets of D15 as reviewed code, driven through the operator's real command (LOB-30):
// `bun infra/src/rulesets.ts plan|apply|verify|probe` against a loopback GitHub that enforces the
// rulesets on `git push`.
//
//   bun .pi/skills/verify-rulesets/drive.ts
//
// Checks:
//   1. plan on a bare repo lists two creates and writes nothing; verify fails, naming both missing
//   2. apply creates both, its own read-back is clean, and verify passes; a second apply is a no-op
//   3. probe — real git, as the factory's push token, with no harness hook anywhere in the path —
//      is refused the force-push and the deletion of factory/ruleset-probe by GH013, and the branch
//      is intact
//   4. the same forge refuses a direct push to main (PR-only) and accepts a force-push to feature/x,
//      so the refusals are the rulesets', not a forge that refuses everything
//   5. a ruleset deleted "in the UI" fails verify, naming it, and the probe then fails because the
//      force-push lands; apply restores it, and verify and the probe pass again
//   6. the factory's App added as a bypass actor fails verify and the probe; apply restores it
//   7. an operator token equal to the factory's GITHUB_TOKEN is refused before any request
//   8. no request left loopback: every child runs with HTTP(S)_PROXY at an egress canary (a loopback
//      listener that records and drops whatever reaches it) and NO_PROXY=127.0.0.1, so a call to
//      any non-loopback host lands in the canary instead of the network; the canary saw nothing, and
//      a control call at a non-loopback API root shows it catches one
//
// The forge is `infra/src/testing/githubFake.ts`, started in this process on FORGE_PORT (default
// 9521); the CLI runs as a child process (`bun --no-env-file`, so no `.env` in the checkout is
// loaded into it) with GITHUB_API_URL pointed at it and only the variables it needs, so no real
// credential and no GITHUB_APP_* of the caller's can reach it.
//
// Env: FORGE_PORT, CANARY_PORT (default 9522), EVIDENCE_DIR.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { startGitHubFake } from "@repo/infra/testing";

const ROOT = path.resolve(import.meta.dir, "../../..");
const EVIDENCE_DIR = path.resolve(
  ROOT,
  process.env["EVIDENCE_DIR"] ?? ".verify/rulesets",
);
const FORGE_PORT = Number(process.env["FORGE_PORT"] ?? "9521");
const CANARY_PORT = Number(process.env["CANARY_PORT"] ?? "9522");
const ADMIN = "verify-rulesets-admin-token";
const WORKER = "verify-rulesets-worker-token";
const REPO = "acme/rulesets-drive";
const SESSIONS = "factory: factory/** is append-only";

mkdirSync(EVIDENCE_DIR, { recursive: true });
const scratch = mkdtempSync(path.join(tmpdir(), "verify-rulesets-"));
const forge = await startGitHubFake({
  root: path.join(scratch, "forge"),
  workerToken: WORKER,
  adminToken: ADMIN,
  port: FORGE_PORT,
  ledger: path.join(EVIDENCE_DIR, "forge-ledger.json"),
});
forge.createRepo(REPO);

/**
 * The egress canary: every child's HTTP(S)_PROXY. A request to a non-loopback host — fetch's or
 * git's — opens a connection here instead of reaching the network; the canary records its first
 * line (`CONNECT host:443 …` or `GET http://host/… …`) and drops it, so the request fails too.
 */
const egress: Array<string> = [];
const canary = createTcpServer((socket) => {
  socket.once("data", (chunk) => {
    egress.push(chunk.toString("latin1").split("\r\n")[0] ?? "");
    socket.destroy();
  });
  socket.on("error", () => undefined);
});
await new Promise<void>((resolve, reject) => {
  canary.once("error", reject);
  canary.listen(CANARY_PORT, "127.0.0.1", resolve);
});
const CANARY = `http://127.0.0.1:${CANARY_PORT}`;
/** Fetch (Bun) and git (curl) both read these; either case, so neither falls through. */
const PROXIED = {
  HTTP_PROXY: CANARY,
  HTTPS_PROXY: CANARY,
  http_proxy: CANARY,
  https_proxy: CANARY,
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
};

type Check = {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
};
const checks: Array<Check> = [];
const check = (name: string, ok: boolean, detail = "") => {
  checks.push({ name, ok, detail });
  console.log(
    `${ok ? "ok  " : "FAIL"}  ${name}${ok || detail === "" ? "" : `\n      ${detail}`}`,
  );
};

type Ran = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};
const transcript: Array<{
  argv: ReadonlyArray<string>;
  code: number;
  stdout: string;
  stderr: string;
}> = [];

/** The operator's command, with only the variables it needs. */
const rulesets = async (
  args: ReadonlyArray<string>,
  env: Record<string, string> = {},
): Promise<Ran> => {
  // `--no-env-file`: Bun loads the cwd's `.env` into a child even when `env` is given, so without it a
  // checkout's `.env` (GITHUB_APP_*, MOTEL_URL, …) would reach the command under test.
  const child = Bun.spawn(
    ["bun", "--no-env-file", "infra/src/rulesets.ts", ...args],
    {
      cwd: ROOT,
      env: {
        ...PROXIED,
        PATH: process.env["PATH"] ?? "",
        HOME: process.env["HOME"] ?? "",
        GITHUB_API_URL: forge.url,
        GITHUB_RULESETS_TOKEN: ADMIN,
        GITHUB_TOKEN: WORKER,
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  transcript.push({ argv: args, code, stdout, stderr });
  return { code, stdout, stderr };
};

const repoArgs = ["--repo", REPO];
const probeArgs = ["probe", ...repoArgs, "--url", forge.gitUrl(REPO), "--json"];

/** A plain git push with nothing of the harness in the way. */
const git = async (args: ReadonlyArray<string>, cwd: string): Promise<Ran> => {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: {
      ...PROXIED,
      PATH: process.env["PATH"] ?? "",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "drive",
      GIT_AUTHOR_EMAIL: "drive@factory.invalid",
      GIT_COMMITTER_NAME: "drive",
      GIT_COMMITTER_EMAIL: "drive@factory.invalid",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout: stdout.trim(), stderr };
};

const ui = (method: string, id: number, body?: unknown) =>
  forge.editAsAdmin(REPO, method, `/${id}`, body);

const sessionsId = () =>
  forge.rulesets(REPO).find((each) => each.name === SESSIONS)?.id ?? -1;
const writesSoFar = () =>
  forge.requests.filter((request) => request.method !== "GET").length;

const parsed = (
  ran: Ran,
): { passed?: boolean; steps?: Array<Record<string, unknown>> } => {
  try {
    return JSON.parse(ran.stdout) as { passed?: boolean };
  } catch {
    return {};
  }
};

try {
  // 1. plan on a bare repo
  const plan = await rulesets(["plan", ...repoArgs]);
  check(
    "plan lists two creates and writes nothing",
    plan.code === 0 &&
      (plan.stdout.match(/^create/gm) ?? []).length === 2 &&
      forge.rulesets(REPO).length === 0,
    plan.stdout + plan.stderr,
  );
  const missing = await rulesets(["verify", ...repoArgs]);
  check(
    "verify on a bare repo fails, naming both rulesets missing",
    missing.code === 1 &&
      (missing.stdout.match(/^missing: /gm) ?? []).length === 2 &&
      missing.stderr.includes("ruleset_drift"),
    missing.stdout + missing.stderr,
  );

  // 2. apply, read back, idempotent
  const apply = await rulesets(["apply", ...repoArgs]);
  check(
    "apply creates both and its read-back is clean",
    apply.code === 0 &&
      (apply.stdout.match(/^created /gm) ?? []).length === 2 &&
      apply.stdout.includes("read back: ok") &&
      forge.rulesets(REPO).length === 2,
    apply.stdout + apply.stderr,
  );
  const verified = await rulesets(["verify", ...repoArgs]);
  check(
    "verify passes after apply",
    verified.code === 0,
    verified.stdout + verified.stderr,
  );
  const before = writesSoFar();
  const again = await rulesets(["apply", ...repoArgs]);
  check(
    "a second apply writes nothing",
    again.code === 0 &&
      again.stdout.includes("nothing to change") &&
      writesSoFar() === before,
    again.stdout + again.stderr,
  );

  // 3. the probe
  const probe = await rulesets(probeArgs);
  const report = parsed(probe);
  writeFileSync(path.join(EVIDENCE_DIR, "probe-enforced.json"), probe.stdout);
  const steps = (report.steps ?? []).map(
    (step) =>
      `${String(step["step"])}:${String(step["outcome"])}:${String(step["ruleViolation"])}`,
  );
  check(
    "probe: the force-push and the deletion of factory/ruleset-probe are refused by GH013, the branch intact",
    probe.code === 0 &&
      report.passed === true &&
      steps.join(",") ===
        "seed:accepted:false,force-push:rejected:true,delete:rejected:true,intact:accepted:false",
    probe.stdout + probe.stderr,
  );
  check(
    "probe: the forge classified the pushes itself (create, force, delete) and refused the last two",
    forge.pushes
      .filter((push) => push.repo === REPO)
      .map((push) => `${push.updates[0]?.kind}:${push.allowed}`)
      .join(",") === "create:true,force:false,delete:false",
    JSON.stringify(forge.pushes),
  );

  // 4. main is PR-only; outside the namespaces nothing binds
  const work = path.join(scratch, "work");
  await git(["init", "--quiet", work], scratch);
  const remote = forge
    .gitUrl(REPO)
    .replace("http://", `http://x-access-token:${WORKER}@`);
  await git(["fetch", "--quiet", remote, "main"], work);
  const tree = (await git(["mktree"], work)).stdout;
  const onMain = (
    await git(["commit-tree", tree, "-p", "FETCH_HEAD", "-m", "direct"], work)
  ).stdout;
  const toMain = await git(["push", remote, `${onMain}:refs/heads/main`], work);
  check(
    "a fast-forward push straight to main is refused: PR-only",
    toMain.code !== 0 &&
      toMain.stderr.includes("GH013") &&
      toMain.stderr.includes("Changes must be made through a pull request."),
    toMain.stderr,
  );
  const feature1 = (await git(["commit-tree", tree, "-m", "feature one"], work))
    .stdout;
  const feature2 = (await git(["commit-tree", tree, "-m", "feature two"], work))
    .stdout;
  await git(["push", remote, `${feature1}:refs/heads/feature/x`], work);
  const forced = await git(
    ["push", "--force", remote, `${feature2}:refs/heads/feature/x`],
    work,
  );
  check(
    "a force-push to feature/x is accepted: the forge refuses only what a ruleset forbids",
    forced.code === 0,
    forced.stderr,
  );

  // 5. a ruleset deleted in the UI
  const deleted = await ui("DELETE", sessionsId());
  const afterDelete = await rulesets(["verify", ...repoArgs]);
  check(
    "a factory/** ruleset deleted in the UI fails verify, naming it",
    deleted === 204 &&
      afterDelete.code === 1 &&
      afterDelete.stdout.includes(`missing: "${SESSIONS}"`),
    afterDelete.stdout + afterDelete.stderr,
  );
  const probeUnprotected = await rulesets(probeArgs);
  writeFileSync(
    path.join(EVIDENCE_DIR, "probe-ruleset-deleted.json"),
    probeUnprotected.stdout,
  );
  check(
    "with it deleted, the force-push lands and the probe fails",
    probeUnprotected.code === 1 &&
      parsed(probeUnprotected).steps?.[1]?.["outcome"] === "accepted" &&
      probeUnprotected.stderr.includes("ruleset_not_enforced"),
    probeUnprotected.stdout + probeUnprotected.stderr,
  );
  const restore = await rulesets(["apply", ...repoArgs]);
  const restored = await rulesets(["verify", ...repoArgs]);
  const probeRestored = await rulesets(probeArgs);
  check(
    "apply restores it: verify and the probe pass again",
    restore.code === 0 &&
      restore.stdout.includes(`created "${SESSIONS}"`) &&
      restored.code === 0 &&
      probeRestored.code === 0,
    restore.stdout +
      restored.stdout +
      probeRestored.stdout +
      probeRestored.stderr,
  );

  // 6. the App as a bypass actor
  await ui("PUT", sessionsId(), {
    bypass_actors: [
      { actor_type: "Integration", actor_id: 4242, bypass_mode: "always" },
    ],
  });
  const bypassed = await rulesets(["verify", ...repoArgs]);
  const probeBypassed = await rulesets(probeArgs);
  check(
    "the factory's App as a bypass actor fails verify and the probe",
    bypassed.code === 1 &&
      bypassed.stdout.includes(
        "bypass actor Integration 4242 (always), declared none",
      ) &&
      probeBypassed.code === 1,
    bypassed.stdout + probeBypassed.stdout,
  );
  const unbypass = await rulesets(["apply", ...repoArgs]);
  check(
    "apply removes the bypass actor",
    unbypass.code === 0 &&
      unbypass.stdout.includes(`updated "${SESSIONS}"`) &&
      (await rulesets(["verify", ...repoArgs])).code === 0,
    unbypass.stdout + unbypass.stderr,
  );

  // 7. the factory's own token as the operator's
  const writesBefore = forge.requests.length;
  const unsafe = await rulesets(["apply", ...repoArgs], {
    GITHUB_RULESETS_TOKEN: WORKER,
  });
  check(
    "an operator token equal to GITHUB_TOKEN is refused before any request",
    unsafe.code === 1 &&
      unsafe.stderr.includes("unsafe_credential") &&
      forge.requests.length === writesBefore,
    unsafe.stderr,
  );

  // 8. loopback only: the canary saw nothing, and it would have
  const escaped = [...egress];
  check(
    "no request left loopback: the egress canary saw nothing from any child",
    escaped.length === 0 && forge.requests.length > 0,
    escaped.join("\n"),
  );
  const control = await rulesets(["verify", ...repoArgs], {
    GITHUB_API_URL: "https://egress-canary.invalid",
  });
  check(
    "the canary catches a non-loopback request (control): it is recorded, and the call fails",
    control.code === 1 &&
      control.stderr.includes("could not be reached") &&
      egress.some((line) => line.includes("egress-canary.invalid")),
    `${egress.join("\n")}\n${control.stderr}`,
  );
} finally {
  await forge.close();
  await new Promise<void>((resolve) => canary.close(() => resolve()));
  rmSync(scratch, { recursive: true, force: true });
}

const passed = checks.every((each) => each.ok);
writeFileSync(
  path.join(EVIDENCE_DIR, "drive.json"),
  JSON.stringify(
    { passed, forge: forge.url, canary: CANARY, egress, checks, transcript },
    null,
    2,
  ),
);
console.log(
  `\n${checks.filter((each) => each.ok).length}/${checks.length} checks passed`,
);
process.exit(passed ? 0 : 1);
