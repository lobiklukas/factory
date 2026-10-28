/**
 * The secret scan a branch passes before its push (S-agent-secrets), against real git histories.
 *
 * Every credential-shaped string here is assembled at run time from pieces, so this file is not
 * itself a line a scanner — this one or a forge's — refuses.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Option, Redacted } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import type { InjectedSecrets } from "@repo/harness";
import {
  parseAddedLines,
  SECRET_SCAN_ALLOW,
  scanAddedLines,
  scanBranchForSecrets,
} from "./secretScan";

const FAKE = "fake-scan-value-0123456789";
const KNOWN: InjectedSecrets = [
  { name: "TEST_API_KEY", value: Redacted.make(FAKE) },
];
const githubToken = () => `gh${"p"}_${"A1b2".repeat(9)}`;
const awsKey = () => `AK${"IA"}${"ABCDEFGHIJKLMNOP"}`;
const pemHeader = () => `-----BEGIN RSA ${"PRIVATE"} KEY-----`;

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t.com",
    },
  }).trim();

/** A repo with `main` holding `base`, and a branch `work` off it. */
const repo = (base: Record<string, string> = {}): string => {
  const root = mkdtempSync(join(tmpdir(), "factory-scan-"));
  dirs.push(root);
  git(root, "init", "-q", "-b", "main");
  for (const [file, text] of Object.entries({ "README.md": "x\n", ...base }))
    writeFileSync(join(root, file), text);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  git(root, "checkout", "-q", "-b", "work");
  return root;
};

const commit = (root: string, files: Record<string, string>): string => {
  for (const [file, text] of Object.entries(files))
    writeFileSync(join(root, file), text);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "change");
  return git(root, "rev-parse", "HEAD");
};

const scan = (root: string, known: InjectedSecrets = KNOWN) =>
  Effect.runPromise(
    scanBranchForSecrets({ checkout: root, base: "main", head: "work", known }),
  );

describe("parseAddedLines", () => {
  it("reads each added line's commit, path and line number, and skips removed ones", () => {
    const log = [
      "\u0000abc123",
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1..2 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -3,0 +4,2 @@",
      "+first",
      "+second",
      "@@ -10 +11 @@",
      "-gone",
      "+++ not a header",
      "diff --git a/old.txt b/old.txt",
      "deleted file mode 100644",
      "--- a/old.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
    ].join("\n");
    expect(parseAddedLines(log)).toEqual([
      { commit: "abc123", path: "src/a.ts", line: 4, text: "first" },
      { commit: "abc123", path: "src/a.ts", line: 5, text: "second" },
      { commit: "abc123", path: "src/a.ts", line: 11, text: "++ not a header" },
    ]);
  });
});

describe("scanAddedLines", () => {
  const at = (text: string) => [{ commit: "c", path: "f", line: 1, text }];

  it("finds a stored value, by name, ahead of any pattern on the line", () => {
    expect(scanAddedLines(at(`key = "${FAKE}" ${githubToken()}`), KNOWN)).toEqual(
      [{ commit: "c", path: "f", line: 1, kind: "stored", name: "TEST_API_KEY" }],
    );
  });

  it("finds well-known credential shapes", () => {
    expect(scanAddedLines(at(githubToken()), [])[0]?.name).toBe("github-token");
    expect(scanAddedLines(at(`id=${awsKey()}`), [])[0]?.name).toBe(
      "aws-access-key-id",
    );
    expect(scanAddedLines(at(pemHeader()), [])[0]?.name).toBe("private-key");
    expect(scanAddedLines(at("const x = 'just a string'"), [])).toEqual([]);
  });

  it("lets the allow marker opt a pattern out, never a stored value", () => {
    expect(
      scanAddedLines(at(`${githubToken()} // ${SECRET_SCAN_ALLOW}`), []),
    ).toEqual([]);
    expect(
      scanAddedLines(at(`${FAKE} // ${SECRET_SCAN_ALLOW}`), KNOWN)[0]?.kind,
    ).toBe("stored");
  });

  it("recognizes one line of a stored multi-line value", () => {
    const pem: InjectedSecrets = [
      {
        name: "DEPLOY_KEY",
        value: Redacted.make(`${pemHeader()}\nMIIEfakebodyline0123456789\n-----END-----`),
      },
    ];
    expect(scanAddedLines(at("MIIEfakebodyline0123456789"), pem)[0]).toMatchObject(
      { kind: "stored", name: "DEPLOY_KEY" },
    );
  });
});

describe("scanBranchForSecrets", () => {
  it("passes a branch that adds no secret", async () => {
    const root = repo();
    commit(root, { "a.txt": "hello\n" });
    expect(Option.isNone(await scan(root))).toBe(true);
  });

  it("refuses a value one commit adds and a later one removes: the push publishes the history", async () => {
    const root = repo();
    const adds = commit(root, { "config.txt": `a\nkey=${FAKE}\n` });
    commit(root, { "config.txt": "a\n" });
    const found = await scan(root);
    expect(Option.getOrUndefined(found)).toEqual({
      outcome: "secret-found",
      count: 1,
      findings: [
        {
          commit: adds,
          path: "config.txt",
          line: 2,
          kind: "stored",
          name: "TEST_API_KEY",
        },
      ],
    });
    expect(JSON.stringify(found)).not.toContain(FAKE);
  });

  it("does not refuse a value the base already held", async () => {
    const root = repo({ "fixture.txt": `${FAKE}\n` });
    commit(root, { "b.txt": "unrelated\n" });
    expect(Option.isNone(await scan(root))).toBe(true);
  });

  it("fails closed when git cannot read the range", async () => {
    const root = repo();
    const failed = await Effect.runPromise(
      scanBranchForSecrets({
        checkout: root,
        base: "main",
        head: "no-such-branch",
        known: KNOWN,
      }).pipe(Effect.flip),
    );
    expect(failed).toMatchObject({ _tag: "PrError", operation: "secretScan" });
  });
});
