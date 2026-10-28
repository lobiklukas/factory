import { BunServices } from "@effect/platform-bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Config, Effect, Option, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The API's boot under each Anthropic auth mode (LOB-258): the real `src/index.ts`, its real logger
 * and pi-ai's real credential lookup over the process environment.
 *
 * Each case starts `bun --no-env-file src/index.ts` with an environment built from nothing but the
 * case (and `PATH`), so neither a developer's shell nor a `.env` can lend it a credential; every
 * credential is a dummy, and nothing contacts Anthropic, because a boot sends no request. The server
 * binds port 0 on loopback, and `DATABASE_URL` names a port nothing listens on: the pool is lazy and
 * migrations retry in the background (`index.ts`), so the boot completes without any database.
 */

const ENTRY = fileURLToPath(new URL("./index.ts", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "factory-api-boot-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The line the server logs once it is bound: the boot is over. */
const LISTENING = "Listening on";

type Boot = {
  /** The exit code when the process ended on its own; `null` when it listened (and was stopped). */
  readonly code: number | null;
  /** stdout and stderr together: every line the process logged until it listened or exited. */
  readonly output: string;
};

/**
 * Boot the API with `env` and nothing else, until it listens or exits on its own. Closing the scope
 * kills a process that is still running, so a listening server is stopped here.
 */
const boot = (env: Readonly<Record<string, string>>): Promise<Boot> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make("bun", ["--no-env-file", ENTRY], {
        cwd: scratch,
        extendEnv: false,
        env: {
          PATH: yield* Config.String("PATH"),
          HOME: scratch,
          PORT: "0",
          HOST: "127.0.0.1",
          SESSION_ROOT: join(scratch, "sessions"),
          DATABASE_URL: "postgres://factory:factory@127.0.0.1:1/unreachable",
          ...env,
        },
        stdin: "ignore",
      }),
    );
    const output = yield* handle.all.pipe(
      Stream.decodeText(),
      Stream.scan(
        () => "",
        (seen: string, chunk: string) => seen + chunk,
      ),
      Stream.takeUntil((seen) => seen.includes(LISTENING)),
      Stream.runLast,
      Effect.map(Option.getOrElse(() => "")),
    );
    if (output.includes(LISTENING)) return { code: null, output };
    return { code: Number(yield* handle.exitCode), output };
  }).pipe(
    Effect.scoped,
    Effect.timeout("20 seconds"),
    Effect.provide(BunServices.layer),
    Effect.runPromise,
  );

describe.concurrent("the API's boot, per Anthropic auth mode (LOB-258)", () => {
  for (const name of [
    "ANTHROPIC_OAUTH_TOKEN",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
  ]) {
    it(`boots on anthropic with only ${name} set, logging its name and never its value`, async () => {
      const value = `dummy-${name.toLowerCase().replaceAll("_", "-")}-0123456789`;
      const { code, output } = await boot({ [name]: value });
      expect(code, output).toBeNull();
      expect(output).toContain(`model backend: anthropic (auth: ${name})`);
      expect(output).not.toContain(value);
      expect(output).not.toContain("faux");
    }, 30_000);
  }

  it("exits non-zero when MODEL_BACKEND forces anthropic and the only key is blank, listing the accepted variables", async () => {
    // A whitespace-only value is not a credential: pi-ai's lookup treats it as unset.
    const { code, output } = await boot({
      MODEL_BACKEND: "anthropic",
      ANTHROPIC_API_KEY: "   ",
      ANTHROPIC_AUTH_TOKEN: "",
    });
    expect(code, output).not.toBeNull();
    expect(code, output).not.toBe(0);
    expect(output).toContain("AnthropicCredentialMissing");
    for (const name of [
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_OAUTH_TOKEN",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_FEDERATION_RULE_ID",
      "ANTHROPIC_ORGANIZATION_ID",
      "ANTHROPIC_IDENTITY_TOKEN_FILE",
    ]) {
      expect(output).toContain(name);
    }
    expect(output).not.toContain("Listening on");
  }, 30_000);

  it("boots on anthropic from workload identity federation when the token file exists", async () => {
    const token = join(scratch, "identity-token");
    writeFileSync(token, "dummy-identity-token-0123456789");
    const { code, output } = await boot({
      MODEL_BACKEND: "anthropic",
      ANTHROPIC_FEDERATION_RULE_ID: "dummy-rule",
      ANTHROPIC_ORGANIZATION_ID: "dummy-org",
      ANTHROPIC_IDENTITY_TOKEN_FILE: token,
    });
    expect(code, output).toBeNull();
    expect(output).toContain(
      "model backend: anthropic (MODEL_BACKEND; auth: workload identity federation)",
    );
    expect(output).not.toContain("dummy-identity-token-0123456789");
  }, 30_000);

  it("exits non-zero when MODEL_BACKEND forces anthropic on a federation whose token file does not exist", async () => {
    const missing = join(scratch, "no-such-identity-token");
    const { code, output } = await boot({
      MODEL_BACKEND: "anthropic",
      ANTHROPIC_FEDERATION_RULE_ID: "dummy-rule",
      ANTHROPIC_ORGANIZATION_ID: "dummy-org",
      ANTHROPIC_IDENTITY_TOKEN_FILE: missing,
    });
    expect(code, output).not.toBeNull();
    expect(code, output).not.toBe(0);
    expect(output).toContain("AnthropicIdentityTokenFileMissing");
    expect(output).toContain(missing);
    expect(output).not.toContain("Listening on");
  }, 30_000);

  it("says faux was selected by MODEL_BACKEND, even with a key set", async () => {
    const { code, output } = await boot({
      MODEL_BACKEND: "faux",
      ANTHROPIC_API_KEY: "dummy-key-that-must-not-matter",
    });
    expect(code, output).toBeNull();
    expect(output).toContain("model backend: faux (selected by MODEL_BACKEND)");
    expect(output).not.toContain("dummy-key-that-must-not-matter");
  }, 30_000);

  it("falls back to faux with no credential, and says the Claude Code token is not read", async () => {
    const { code, output } = await boot({
      CLAUDE_CODE_OAUTH_TOKEN: "dummy-subscription-token",
    });
    expect(code, output).toBeNull();
    expect(output).toContain(
      "model backend: faux (no Anthropic credential resolved)",
    );
    expect(output).toContain("CLAUDE_CODE_OAUTH_TOKEN is set but not read");
    expect(output).not.toContain("dummy-subscription-token");
  }, 30_000);
});
