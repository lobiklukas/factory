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
  COMMIT_METADATA_PATH,
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
  // Removing every case's git checkouts outran vitest's 10 s hook default on a loaded machine (DEFLAKE).
}, 60_000);

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

const commit = (
  root: string,
  files: Record<string, string>,
  message = "change",
): string => {
  for (const [file, text] of Object.entries(files))
    writeFileSync(join(root, file), text);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
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

  it("reads a merge's combined diff: a line new to any parent is added, a removed one is not", () => {
    const log = [
      "\u0000def456",
      "diff --cc src/b.ts",
      "index 1,2..3",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@@ -1,0 -1,1 +1,2 @@@",
      "++resolved",
      " +from the first parent",
      " -gone",
    ].join("\n");
    expect(parseAddedLines(log)).toEqual([
      { commit: "def456", path: "src/b.ts", line: 1, text: "resolved" },
      {
        commit: "def456",
        path: "src/b.ts",
        line: 2,
        text: "from the first parent",
      },
    ]);
  });
});

describe("scanAddedLines", () => {
  const at = (text: string) => [{ commit: "c", path: "f", line: 1, text }];

  it("finds a stored value, by name, ahead of any pattern on the line", () => {
    expect(
      scanAddedLines(at(`key = "${FAKE}" ${githubToken()}`), KNOWN),
    ).toEqual([
      { commit: "c", path: "f", line: 1, kind: "stored", name: "TEST_API_KEY" },
    ]);
  });

  it("finds well-known credential shapes", () => {
    expect(scanAddedLines(at(githubToken()), [])[0]?.name).toBe("github-token");
    expect(scanAddedLines(at(`id=${awsKey()}`), [])[0]?.name).toBe(
      "aws-access-key-id",
    );
    expect(scanAddedLines(at(pemHeader()), [])[0]?.name).toBe("private-key");
    expect(scanAddedLines(at("const x = 'just a string'"), [])).toEqual([]);
  });

  it("lets the allow marker opt a pattern out in a file the base marks, never a stored value", () => {
    const marked = new Set(["f"]);
    expect(
      scanAddedLines(
        at(`${githubToken()} // ${SECRET_SCAN_ALLOW}`),
        [],
        marked,
      ),
    ).toEqual([]);
    expect(
      scanAddedLines(at(`${FAKE} // ${SECRET_SCAN_ALLOW}`), KNOWN, marked)[0]
        ?.kind,
    ).toBe("stored");
  });

  /**
   * Mutation: honour the marker on any line — an agent that found a forge token appends the marker
   * to the line, or to its commit message, and the pattern check waves it through.
   */
  it("ignores the allow marker in a file the base does not mark, and in commit metadata", () => {
    const line = `${githubToken()} // ${SECRET_SCAN_ALLOW}`;
    expect(scanAddedLines(at(line), [])[0]?.name).toBe("github-token");
    expect(
      scanAddedLines(
        [{ commit: "c", path: COMMIT_METADATA_PATH, line: 5, text: line }],
        [],
        new Set([COMMIT_METADATA_PATH]),
      )[0]?.name,
    ).toBe("github-token");
  });

  it("recognizes one line of a stored multi-line value", () => {
    const pem: InjectedSecrets = [
      {
        name: "DEPLOY_KEY",
        value: Redacted.make(
          `${pemHeader()}\nMIIEfakebodyline0123456789\n-----END-----`,
        ),
      },
    ];
    expect(
      scanAddedLines(at("MIIEfakebodyline0123456789"), pem)[0],
    ).toMatchObject({ kind: "stored", name: "DEPLOY_KEY" });
  });

  /**
   * Mutation: treat every line of a multi-line value as the secret — `apiVersion: v1` in any
   * manifest the branch adds is refused as the stored kubeconfig, and every PR on the repo with it.
   */
  it("does not refuse a boilerplate line a stored multi-line document shares, only its key material", () => {
    const token = "FakeKubeToken0123456789abcdefXYZ";
    const kubeconfig: InjectedSecrets = [
      {
        name: "KUBECONFIG",
        value: Redacted.make(
          [
            "apiVersion: v1",
            "kind: Config",
            "users:",
            "- name: ci",
            "  user:",
            `    token: ${token}`,
          ].join("\n"),
        ),
      },
    ];
    expect(scanAddedLines(at("apiVersion: v1"), kubeconfig)).toEqual([]);
    expect(scanAddedLines(at("kind: Config"), kubeconfig)).toEqual([]);
    expect(
      scanAddedLines(at(`auth = "${token}"`), kubeconfig)[0],
    ).toMatchObject({ kind: "stored", name: "KUBECONFIG" });
    const serviceAccount: InjectedSecrets = [
      {
        name: "GCP_SA",
        value: Redacted.make(
          JSON.stringify(
            {
              type: "service_account",
              token_uri: "https://oauth2.googleapis.com/token",
              private_key: `${pemHeader()}\nMIIEvQIBADANfakeBody0123456789\n-----END-----\n`,
            },
            null,
            2,
          ),
        ),
      },
    ];
    expect(
      scanAddedLines(
        at('  "token_uri": "https://oauth2.googleapis.com/token",'),
        serviceAccount,
      ),
    ).toEqual([]);
    expect(
      scanAddedLines(at("MIIEvQIBADANfakeBody0123456789"), serviceAccount)[0],
    ).toMatchObject({ kind: "stored", name: "GCP_SA" });
  });

  it("masks a stored value or a credential's shape in a finding's path", () => {
    const [found] = scanAddedLines(
      [{ commit: "c", path: `dir/${FAKE}/x.txt`, line: 1, text: FAKE }],
      KNOWN,
    );
    expect(found?.path).toBe("dir/[secret]/x.txt");
    const [shaped] = scanAddedLines(
      [
        {
          commit: "c",
          path: `${githubToken()}.txt`,
          line: 1,
          text: githubToken(),
        },
      ],
      [],
    );
    expect(shaped?.path).toBe("[secret].txt");
  });
});

// Each case runs a handful of real git commands, which a loaded machine can take seconds over.
// Each case builds a branch with git and scans it with git: past the 30 s this was on a loaded
// machine (DEFLAKE).
describe("scanBranchForSecrets", { timeout: 60_000 }, () => {
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

  /**
   * Mutation: drop `--text` from the scan's log — the branch's own `* -diff` makes git print
   * `Binary files … differ` with no hunk, and the stored value is pushed unscanned.
   */
  it("refuses a value in a file the branch's own .gitattributes marks -diff", async () => {
    const root = repo();
    commit(root, {
      ".gitattributes": "* -diff\n",
      "leaked.txt": `aws=${awsKey()}\nkey=${FAKE}\n`,
    });
    const found = Option.getOrUndefined(await scan(root));
    expect(found?.findings.map((finding) => finding.name).sort()).toEqual([
      "TEST_API_KEY",
      "aws-access-key-id",
    ]);
  });

  it("refuses a value in a file git would call binary (a NUL byte)", async () => {
    const root = repo();
    commit(root, { "blob.db": `\u0000\u0001header\n${FAKE}\u0000tail\n` });
    const found = Option.getOrUndefined(await scan(root));
    expect(found?.findings[0]).toMatchObject({
      path: "blob.db",
      kind: "stored",
      name: "TEST_API_KEY",
    });
  });

  /** Mutation: scan only the patches — a token quoted in a commit message is pushed. */
  it("refuses a credential in a commit message, and in a path, never quoting it", async () => {
    const root = repo();
    const quoted = commit(
      root,
      { "a.txt": "hello\n" },
      `fix: use ${githubToken()}`,
    );
    const found = Option.getOrUndefined(await scan(root));
    expect(found?.findings).toEqual([
      {
        commit: quoted,
        path: COMMIT_METADATA_PATH,
        line: 5,
        kind: "pattern",
        name: "github-token",
      },
    ]);
    const named = repo();
    commit(named, { [`${FAKE}.txt`]: "" });
    const byPath = Option.getOrUndefined(await scan(named));
    expect(byPath?.findings).toMatchObject([
      { path: COMMIT_METADATA_PATH, kind: "stored", name: "TEST_API_KEY" },
    ]);
    expect(JSON.stringify([found, byPath])).not.toContain(FAKE);
    expect(JSON.stringify(found)).not.toContain(githubToken());
  });

  /**
   * Mutation: diff a merge against its first parent — a pattern-shaped fixture the base gained is
   * counted as the branch's when the branch merges the base, and the run's PR is refused for it.
   */
  it("does not count what a merge brings from the base, but does count what the merge adds", async () => {
    const root = repo();
    commit(root, { "a.txt": "work\n" });
    git(root, "checkout", "-q", "main");
    commit(root, {
      "fixture.txt": `${githubToken()}\n`,
    });
    git(root, "checkout", "-q", "work");
    git(root, "merge", "-q", "--no-edit", "main");
    expect(Option.isNone(await scan(root))).toBe(true);
    // A merge that adds a line of its own (an evil merge) is the branch's, and is scanned.
    writeFileSync(join(root, "resolution.txt"), `${FAKE}\n`);
    git(root, "add", "resolution.txt");
    git(root, "commit", "-q", "--amend", "--no-edit");
    const found = Option.getOrUndefined(await scan(root));
    expect(found?.findings).toMatchObject([
      { path: "resolution.txt", kind: "stored", name: "TEST_API_KEY" },
    ]);
  });

  it("stops at every excluded commit as well as the base", async () => {
    const root = repo();
    const pushed = commit(root, { "old.txt": `key=${FAKE}\n` });
    commit(root, { "new.txt": "fine\n" });
    expect(Option.isSome(await scan(root))).toBe(true);
    const bounded = await Effect.runPromise(
      scanBranchForSecrets({
        checkout: root,
        base: "main",
        head: "work",
        exclude: [pushed],
        known: KNOWN,
      }),
    );
    expect(Option.isNone(bounded)).toBe(true);
  });

  it("honours the allow marker only in a file that carries it at the base", async () => {
    const root = repo({ "fixture.ts": `// ${SECRET_SCAN_ALLOW}\n` });
    commit(root, {
      "fixture.ts": `// ${SECRET_SCAN_ALLOW}\nconst t = "${githubToken()}"; // ${SECRET_SCAN_ALLOW}\n`,
    });
    expect(Option.isNone(await scan(root))).toBe(true);
    commit(
      root,
      { "new.ts": `const t = "${githubToken()}"; // ${SECRET_SCAN_ALLOW}\n` },
      `add ${githubToken()} ${SECRET_SCAN_ALLOW}`,
    );
    const found = Option.getOrUndefined(await scan(root));
    expect(
      found?.findings.map((finding) => [finding.path, finding.name]),
    ).toEqual([
      ["new.ts", "github-token"],
      [COMMIT_METADATA_PATH, "github-token"],
    ]);
  });

  /**
   * Mutation: drop `log.showRoot=true` from the scan's settings — the agent sets `log.showRoot false`
   * in the checkout's shared config, merges an orphan commit holding the value, and the dense
   * combined diff (the file matches one parent) and the unprinted root patch both hide it.
   */
  it("refuses a value an orphan commit merged into the branch adds, whatever the repo's log.showRoot", async () => {
    const root = repo();
    git(root, "checkout", "-q", "--orphan", "orphan");
    git(root, "rm", "-rq", "--cached", ".");
    rmSync(join(root, "README.md"));
    commit(root, { "leak.txt": `${FAKE}\n` });
    git(root, "checkout", "-q", "work");
    git(
      root,
      "merge",
      "-q",
      "--no-edit",
      "--allow-unrelated-histories",
      "orphan",
    );
    git(root, "config", "log.showRoot", "false");
    const found = Option.getOrUndefined(await scan(root));
    expect(found?.findings).toMatchObject([
      { path: "leak.txt", kind: "stored", name: "TEST_API_KEY" },
    ]);
  });

  /**
   * Mutation: drop `--encoding=none` and the pinned `i18n.logOutputEncoding` — the agent sets the
   * checkout's output encoding to UTF-16, and a value in a commit message is read as other bytes.
   */
  it("refuses a value in a commit message, whatever the repo's i18n.logOutputEncoding", async () => {
    const root = repo();
    commit(root, { "a.txt": "hello\n" }, `note ${FAKE}`);
    git(root, "config", "i18n.logOutputEncoding", "UTF-16");
    const found = Option.getOrUndefined(await scan(root));
    expect(found?.findings).toMatchObject([
      { path: COMMIT_METADATA_PATH, kind: "stored", name: "TEST_API_KEY" },
    ]);
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
