/**
 * The secret scan a branch passes before the control plane pushes it (S-agent-secrets): every line
 * the branch's commits add, checked for a value the factory stores for the repo and for the shape of
 * a well-known credential.
 *
 * **Every commit, not the net diff.** A push publishes the history, so a value one commit adds and a
 * later one removes is still on the forge once pushed. The scan reads `git log -p base..head` — each
 * commit's patch against its first parent, with no context lines — and checks each added line.
 *
 * **Two kinds of finding.** A `stored` finding is a line holding the value of one of the repo's
 * secrets, whatever the run was given: the store knows them all, and a value reaching a commit is
 * exactly what the store exists to prevent. A `pattern` finding is a line matching a credential's
 * well-known shape (`SECRET_PATTERNS`): a forge token, a cloud key, a private key's armour. A line can
 * opt out of the pattern check — a test fixture that has to spell one — by carrying
 * `SECRET_SCAN_ALLOW` on the same line; nothing opts a stored value out.
 *
 * **Fails closed.** A scan git cannot answer is a `PrError`, never a pass: a push nobody scanned is
 * the push this exists to stop. The matched text is never in a finding (`@repo/domain/PullRequest`'s
 * `SecretFinding`), only where it is and which rule it broke.
 */
// oxlint-disable-next-line effecttsgo/node-builtin-import -- the scan is the local git CLI, as `prStep.ts`'s measurement is.
import { execFile } from "node:child_process";
import { Effect, Option, Redacted } from "effect";
import {
  PrError,
  SECRET_FINDINGS_LIMIT,
  type SecretFinding,
  type SecretFoundPullRequest,
} from "@repo/domain/PullRequest";
import { SECRET_MIN_LENGTH } from "@repo/domain/Secret";
import type { InjectedSecrets } from "@repo/harness";

/** One credential shape the scan refuses, by the name a finding reports it under. */
export type SecretPattern = { readonly name: string; readonly pattern: RegExp };

/**
 * The credential shapes a branch may not add. High-precision ones only — each a prefix or armour a
 * provider puts on its own tokens — so the scan refuses what is a credential and not what merely
 * looks random.
 */
export const SECRET_PATTERNS: ReadonlyArray<SecretPattern> = [
  {
    name: "private-key",
    pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/,
  },
  { name: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  {
    name: "github-fine-grained-token",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/,
  },
  { name: "gitlab-token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/ },
  { name: "slack-token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { name: "stripe-secret-key", pattern: /\b[rs]k_live_[0-9A-Za-z]{24,}\b/ },
  { name: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/ },
  { name: "anthropic-api-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{32,}/ },
  {
    name: "openai-api-key",
    pattern: /\bsk-[A-Za-z0-9_-]{8,}T3BlbkFJ[A-Za-z0-9_-]{8,}/,
  },
  { name: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
];

/** The marker a line carries to opt out of the pattern check (never of a stored value's). */
export const SECRET_SCAN_ALLOW = "factory-secret-scan:allow";

/** One line a commit adds: the commit, the path and the line number in that commit's file. */
export type AddedLine = {
  readonly commit: string;
  readonly path: string;
  readonly line: number;
  readonly text: string;
};

/** The marker `git log --format` puts before each commit's patch. */
const COMMIT_MARK = "\u0000";

/** A `+++ b/<path>` header's path, unquoted as git quotes an unusual one; `undefined` for `/dev/null`. */
const headerPath = (header: string): string | undefined => {
  const raw = header.slice(4);
  if (raw === "/dev/null") return undefined;
  const unquoted =
    raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  return unquoted.startsWith("b/") ? unquoted.slice(2) : unquoted;
};

/**
 * The added lines of `git log -p -U0 --format=%x00%H`'s output. A file header (`diff --git` up to the
 * first `@@`) names the path; a hunk header names the line the additions start at; a `+` line in a
 * hunk is one addition. A binary file has no hunk, so it adds no line here.
 */
export const parseAddedLines = (log: string): ReadonlyArray<AddedLine> => {
  const added: AddedLine[] = [];
  let commit = "";
  let path: string | undefined;
  let inHeader = false;
  let next = 0;
  for (const line of log.split("\n")) {
    if (line.startsWith(COMMIT_MARK)) {
      commit = line.slice(COMMIT_MARK.length).trim();
      path = undefined;
      inHeader = false;
      continue;
    }
    if (line.startsWith("diff --git ")) {
      path = undefined;
      inHeader = true;
      continue;
    }
    if (inHeader) {
      if (line.startsWith("+++ ")) path = headerPath(line);
      if (!line.startsWith("@@")) continue;
      inHeader = false;
    }
    if (line.startsWith("@@")) {
      const start = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      next = start === null ? 0 : Number(start[1]);
      continue;
    }
    if (path === undefined) continue;
    if (line.startsWith("+")) {
      added.push({ commit, path, line: next, text: line.slice(1) });
      next += 1;
    } else if (line.startsWith(" ")) {
      next += 1;
    }
  }
  return added;
};

/**
 * The texts a stored value is recognized by: the whole value, and for a value of several lines (a
 * PEM key) each of its lines long enough to be its own, less armour every such value shares.
 */
const needlesOf = (
  secrets: InjectedSecrets,
): ReadonlyArray<{ readonly name: string; readonly text: string }> =>
  secrets.flatMap((secret) => {
    const value = Redacted.value(secret.value);
    if (value === "") return [];
    const lines = value.includes("\n")
      ? value
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(
            (line) =>
              line.length >= SECRET_MIN_LENGTH && !line.startsWith("-----"),
          )
      : [];
    return [value, ...lines].map((text) => ({ name: secret.name, text }));
  });

/** Every finding in `lines`: at most one per line, a stored value ahead of a pattern. */
export const scanAddedLines = (
  lines: ReadonlyArray<AddedLine>,
  known: InjectedSecrets,
): ReadonlyArray<SecretFinding> => {
  const needles = needlesOf(known);
  return lines.flatMap((added): ReadonlyArray<SecretFinding> => {
    const where = {
      commit: added.commit,
      path: added.path,
      line: added.line,
    };
    const stored = needles.find((needle) => added.text.includes(needle.text));
    if (stored !== undefined) {
      return [{ ...where, kind: "stored" as const, name: stored.name }];
    }
    if (added.text.includes(SECRET_SCAN_ALLOW)) return [];
    const pattern = SECRET_PATTERNS.find((rule) =>
      rule.pattern.test(added.text),
    );
    return pattern === undefined
      ? []
      : [{ ...where, kind: "pattern" as const, name: pattern.name }];
  });
};

/** The refusal for `findings`, or `none` when there are none. */
export const secretRefusal = (
  findings: ReadonlyArray<SecretFinding>,
): Option.Option<SecretFoundPullRequest> =>
  findings.length === 0
    ? Option.none()
    : Option.some({
        outcome: "secret-found",
        findings: findings.slice(0, SECRET_FINDINGS_LIMIT),
        count: findings.length,
      });

/** How long the log may take: local, no network; a minute only bounds a wedged git. */
const SCAN_TIMEOUT_MS = 60_000;

/**
 * The most the log may print. The diff cap bounds the branch's net change, not its history, so this
 * is generous; a history past it is refused as unscanned rather than scanned in part.
 */
const SCAN_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Scan the commits `base..head` adds in `checkout` (the session's worktree), answering the refusal
 * when any added line holds a stored value or a credential's shape, and `none` when none does. A
 * git that cannot answer — a ref that does not resolve, a history past `SCAN_MAX_BUFFER` — is a
 * `PrError` on `secretScan`.
 */
export const scanBranchForSecrets = (input: {
  readonly checkout: string;
  readonly base: string;
  readonly head: string;
  readonly known: InjectedSecrets;
}): Effect.Effect<Option.Option<SecretFoundPullRequest>, PrError> => {
  const refused = new PrError({
    operation: "secretScan",
    ref: `${input.base}..${input.head}`,
    message:
      "the branch's commits could not be scanned for secrets, so nothing was pushed",
  });
  return Effect.callback<Option.Option<SecretFoundPullRequest>, PrError>(
    (resume, signal) => {
      execFile(
        "git",
        [
          // No hook, no fsmonitor, no pager config, no textconv: the patch is the bytes committed.
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.quotePath=false",
          "log",
          "--format=%x00%H",
          "-p",
          "-U0",
          "-M",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          "--diff-merges=first-parent",
          "--end-of-options",
          `${input.base}..${input.head}`,
          "--",
        ],
        {
          cwd: input.checkout,
          encoding: "utf8",
          signal,
          timeout: SCAN_TIMEOUT_MS,
          maxBuffer: SCAN_MAX_BUFFER,
        },
        (error, stdout) =>
          resume(
            error === null
              ? Effect.succeed(
                  secretRefusal(
                    scanAddedLines(parseAddedLines(stdout), input.known),
                  ),
                )
              : Effect.fail(refused),
          ),
      );
    },
  ).pipe(Effect.withSpan("secretScan.branch"));
};
