/**
 * Secrets in a session's commands (S-agent-secrets): a declared command gets its secret as a
 * variable, the agent's shell never does, and no value reaches anything the log commits.
 *
 * The session cases run the real `openSession` over a storage that records every write it is asked
 * to commit, so "the value is in no log entry" is asserted over the whole stream of commits — the
 * tool's progress commits and its documents included — not over one projection of it. The values
 * are obviously fake, and the commands are the real `NodeExecutionEnv`'s.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import type { Seq, StorageWrite } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { Effect, Redacted } from "effect";
import { describe, expect, it } from "vitest";
import { createFauxModelAccess } from "./models";
import {
  maskJson,
  maskSecrets,
  maskToolResult,
  secretMasker,
  type InjectedSecrets,
} from "./secrets";
import {
  closeHarness,
  openSession,
  readSessionLog,
  submitMessage,
} from "./session";
import { runSetup } from "./setup";
import { execToExit, readVerifyRecords, VERIFY_TOOL } from "./verify";

const FAKE_KEY = "fake-test-api-key-0123456789";
const SECRETS: InjectedSecrets = [
  { name: "TEST_API_KEY", value: Redacted.make(FAKE_KEY) },
];

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(effect);

/** Every write any commit carried, as JSON: what the log was asked to hold, whatever projects it. */
class RecordingStorage extends MemoryStorage {
  readonly written: string[] = [];
  override commit(
    writes: readonly StorageWrite[],
    context: Context,
  ): Promise<Seq> {
    this.written.push(JSON.stringify(writes));
    return super.commit(writes, context);
  }
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });

const checkout = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), "factory-secrets-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "secrets@localhost");
  git(root, "config", "user.name", "secrets");
  for (const [path, content] of Object.entries({
    "README.md": "# fixture\n",
    ...files,
  })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  git(root, "checkout", "-q", "-b", "factory/fixture");
  return root;
};

describe("maskSecrets and secretMasker", () => {
  it("replaces every occurrence of a value with its placeholder", () => {
    expect(maskSecrets(`a ${FAKE_KEY} b ${FAKE_KEY}`, SECRETS)).toBe(
      "a [secret:TEST_API_KEY] b [secret:TEST_API_KEY]",
    );
    expect(maskSecrets("nothing here", SECRETS)).toBe("nothing here");
  });

  it("masks the longer of two overlapping values whole", () => {
    const secrets: InjectedSecrets = [
      { name: "SHORT", value: Redacted.make("abcdefgh") },
      { name: "LONG", value: Redacted.make("abcdefgh-ijklmnop") },
    ];
    expect(maskSecrets("x abcdefgh-ijklmnop abcdefgh", secrets)).toBe(
      "x [secret:LONG] [secret:SHORT]",
    );
  });

  it("masks a value split across chunks, and lets a false start go", () => {
    const masker = secretMasker(SECRETS);
    const out = [
      masker.push("key=fake-test-"),
      masker.push("api-key-0123"),
      masker.push("456789\nnext fake-te"),
      masker.push("rminal\n"),
      masker.push("tail fake-"),
      masker.flush(),
    ].join("");
    expect(out).toBe(
      "key=[secret:TEST_API_KEY]\nnext fake-terminal\ntail fake-",
    );
    expect(out).not.toContain(FAKE_KEY);
  });

  it("holds back nothing for output that starts no value", () => {
    const masker = secretMasker(SECRETS);
    expect(masker.push("plain output\n")).toBe("plain output\n");
    expect(masker.flush()).toBe("");
  });

  it("masks every string in a JSON value", () => {
    expect(
      maskJson({ a: [FAKE_KEY, 1, { b: `x${FAKE_KEY}` }], c: null }, SECRETS),
    ).toEqual({
      a: ["[secret:TEST_API_KEY]", 1, { b: "x[secret:TEST_API_KEY]" }],
      c: null,
    });
  });
});

describe("maskToolResult", () => {
  it("masks a result's text content and its details, and leaves other parts alone", () => {
    expect(
      maskToolResult(
        {
          content: [
            { type: "text", text: `value ${FAKE_KEY}` },
            { type: "image", data: FAKE_KEY, mimeType: "image/png" },
          ],
          details: { output: FAKE_KEY },
          isError: false,
        },
        SECRETS,
      ),
    ).toEqual({
      content: [
        { type: "text", text: "value [secret:TEST_API_KEY]" },
        { type: "image", data: FAKE_KEY, mimeType: "image/png" },
      ],
      details: { output: "[secret:TEST_API_KEY]" },
      isError: false,
    });
  });
});

describe("execToExit with secrets", () => {
  it("gives the command its secret and masks what it prints, one byte at a time too", async () => {
    const root = checkout({});
    const env = new NodeExecutionEnv({ cwd: root });
    const printed: string[] = [];
    const exitCode = await run(
      execToExit({
        env,
        // The value printed a character at a time, so it arrives split however the pipe splits it.
        command:
          'test "$TEST_API_KEY" = "fake-test-api-key-0123456789" && printf "%s" "$TEST_API_KEY" | fold -w1 | tr -d "\\n" && echo',
        cwd: root,
        secrets: SECRETS,
        onOutput: (text) => printed.push(text),
        context: BACKGROUND_CONTEXT,
      }),
    );
    expect(exitCode).toBe(0);
    expect(printed.join("")).toBe("[secret:TEST_API_KEY]\n");
  });

  it("does not let a secret override the command's own variables", async () => {
    const root = checkout({});
    const env = new NodeExecutionEnv({ cwd: root });
    const printed: string[] = [];
    await run(
      execToExit({
        env,
        command: 'echo "db=$DATABASE_URL"',
        cwd: root,
        variables: { DATABASE_URL: "postgres://no-database.invalid/none" },
        secrets: [
          {
            name: "DATABASE_URL",
            value: Redacted.make("postgres://fake-real-database/x"),
          },
        ],
        onOutput: (text) => printed.push(text),
        context: BACKGROUND_CONTEXT,
      }),
    );
    expect(printed.join("")).toBe("db=postgres://no-database.invalid/none\n");
  });
});

describe("runSetup with secrets", () => {
  it("gives each step the setup's secrets and records only the placeholder", async () => {
    const root = checkout({});
    const env = new NodeExecutionEnv({ cwd: root });
    const record = await run(
      runSetup({
        env,
        commands: {
          install: 'test -n "$TEST_API_KEY" && echo "token $TEST_API_KEY"',
        },
        secrets: SECRETS,
        missingSecrets: ["NPM_TOKEN"],
      }),
    );
    expect(record?.outcome).toBe("succeeded");
    const output = record?.steps[0]?.output ?? "";
    expect(output).toContain("token [secret:TEST_API_KEY]");
    expect(output).toContain(
      "== secrets: TEST_API_KEY, NPM_TOKEN (declared, not stored)",
    );
    expect(JSON.stringify(record)).not.toContain(FAKE_KEY);
  });
});

/** pi-ai's faux provider, scripted to make `calls` one after another, then answer. */
const scriptedModel = (
  calls: ReadonlyArray<{
    readonly tool: string;
    readonly args?: Record<string, string>;
  }>,
) => {
  const { access, faux } = createFauxModelAccess();
  const step: FauxResponseFactory = (context) => {
    faux.appendResponses([step]);
    const done = context.messages.filter(
      (message) => message.role === "toolResult",
    ).length;
    const next = calls[done];
    if (next === undefined) return fauxAssistantMessage("done");
    return fauxAssistantMessage(
      fauxToolCall(next.tool, next.args ?? {}),
      { stopReason: "toolUse" },
    );
  };
  faux.setResponses([step]);
  return access;
};

describe("a session given a verify secret", () => {
  it("passes a verify that needs it, while the agent's env lacks it and no commit holds it", async () => {
    const root = checkout({});
    const storage = new RecordingStorage();
    const turn = await run(
      Effect.gen(function* () {
        const { harness, root: conversation } = yield* openSession({
          storage,
          // `env` is the agent's own shell; the verify command leaves the value in a file, and the
          // agent reads it back — the one path only the result hook masks.
          model: scriptedModel([
            {
              tool: "bash",
              args: { command: "env; mkdir -p src && echo change > src/a.txt" },
            },
            { tool: VERIFY_TOOL },
            { tool: "bash", args: { command: "cat .verify-left.txt" } },
            // `read` runs no command: only the settled-result hook stands between it and the log.
            { tool: "read", args: { path: ".verify-left.txt" } },
          ]),
          cwd: root,
          verify: {
            // The value is checked by its digest: a command spelling it would put it in the log.
            command: `test "$(printf %s "$TEST_API_KEY" | shasum -a 256 | cut -c1-64)" = "${createHash("sha256").update(FAKE_KEY).digest("hex")}" && echo "verify key=$TEST_API_KEY" && echo "$TEST_API_KEY" > .verify-left.txt`,
            secrets: SECRETS,
          },
          secrets: SECRETS,
        });
        const submitted = yield* submitMessage(conversation, {
          content: "verify with the key",
          requestId: "secrets-request",
        });
        const settled = yield* Effect.promise(() =>
          submitted.submission.wait(BACKGROUND_CONTEXT),
        );
        const records = yield* readVerifyRecords(storage);
        const log = yield* readSessionLog(storage);
        yield* closeHarness(harness);
        return { status: settled.status, records, log };
      }),
    );
    expect(turn.status).toBe("done");
    const [record] = turn.records;
    if (record?._tag !== "VerifyReport") throw new Error("no verify report");
    const [result] = record.results;
    if (result?._tag !== "VerifyRan") throw new Error("verify did not run");
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("verify key=[secret:TEST_API_KEY]");

    const results = turn.log.entries.filter(
      (entry) => entry.kind === "toolResult",
    );
    expect(results).toHaveLength(4);
    // The agent's `env` printed the environment, and the key is not in it, by name or by value.
    const envResult = JSON.stringify(results[0]);
    expect(envResult).toContain("PATH=");
    expect(envResult).not.toContain("TEST_API_KEY");
    expect(JSON.stringify(results[2])).toContain("[secret:TEST_API_KEY]");
    expect(JSON.stringify(results[3])).toContain("[secret:TEST_API_KEY]");

    expect(storage.written.length).toBeGreaterThan(0);
    for (const written of storage.written) {
      expect(written).not.toContain(FAKE_KEY);
    }
  }, 30_000);
});
