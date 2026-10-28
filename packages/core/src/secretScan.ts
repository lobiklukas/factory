/**
 * The secret scan a branch passes before the control plane pushes it (S-agent-secrets): every line
 * the branch's commits add, and every commit's message, author, committer and paths, checked for a
 * value the factory stores for the repo and for the shape of a well-known credential.
 *
 * **Every commit, not the net diff.** A push publishes the history, so a value one commit adds and a
 * later one removes is still on the forge once pushed. The scan reads `git log -p` over the commits
 * the push may send — `head`, less what `base` (and any `exclude`) already reaches — each commit's
 * patch against its parent with no context lines, and checks each added line. A merge is read as a
 * dense combined diff, so what it brings from its other parent is not counted as its own, while a
 * line the merge itself introduces (a conflict's resolution) is. The bytes are read as text whatever
 * the repo's attributes say: a `* -diff` in a `.gitattributes` the branch adds, or a NUL byte in a
 * file, would otherwise print `Binary files … differ` and hide every line of it.
 *
 * **Two kinds of finding.** A `stored` finding is a line holding the value of one of the repo's
 * secrets, whatever the run was given: the store knows them all, and a value reaching a commit is
 * exactly what the store exists to prevent. A `pattern` finding is a line matching a credential's
 * well-known shape (`SECRET_PATTERNS`): a forge token, a cloud key, a private key's armour. A line can
 * opt out of the pattern check — a test fixture that has to spell one — by carrying
 * `SECRET_SCAN_ALLOW` on the same line; nothing opts a stored value out. The patterns apply to every
 * repo, with or without a store.
 *
 * **Fails closed.** A scan git cannot answer is a `PrError`, never a pass: a push nobody scanned is
 * the push this exists to stop. The matched text is never in a finding (`@repo/domain/PullRequest`'s
 * `SecretFinding`), only where it is and which rule it broke — and a path that itself holds a match
 * is reported with the match masked.
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
  {
    name: "google-api-key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/,
  },
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
 * A hunk header — `@@ -a +b @@` for a commit's patch, `@@@ -a -b +c @@@` for a merge's combined one —
 * as how many parents it diffs against and the line its additions start at.
 */
const hunkHeader = /^(@{2,}) (?:-\d+(?:,\d+)? )+\+(\d+)(?:,\d+)? @{2,}/;

/**
 * The added lines of `git log -p -U0 --format=%x00%H`'s output. A file header (`diff --git`, or
 * `diff --cc` for a merge, up to the first hunk) names the path; a hunk header names the line the
 * additions start at and how many parents' columns prefix each line; a line whose prefix holds a `+`
 * is one addition. The patch is read as text (`--text`), so every file has hunks here.
 */
export const parseAddedLines = (log: string): ReadonlyArray<AddedLine> => {
  const added: AddedLine[] = [];
  let commit = "";
  let path: string | undefined;
  let inHeader = false;
  let parents = 1;
  let next = 0;
  for (const line of log.split("\n")) {
    if (line.startsWith(COMMIT_MARK)) {
      commit = line.slice(COMMIT_MARK.length).trim();
      path = undefined;
      inHeader = false;
      continue;
    }
    if (
      line.startsWith("diff --git ") ||
      line.startsWith("diff --cc ") ||
      line.startsWith("diff --combined ")
    ) {
      path = undefined;
      inHeader = true;
      continue;
    }
    if (inHeader) {
      if (line.startsWith("+++ ")) path = headerPath(line);
      if (!line.startsWith("@@")) continue;
      inHeader = false;
    }
    const hunk = hunkHeader.exec(line);
    if (hunk !== null) {
      parents = (hunk[1]?.length ?? 2) - 1;
      next = Number(hunk[2]);
      continue;
    }
    if (path === undefined) continue;
    const prefix = line.slice(0, parents);
    if (prefix.length < parents) continue;
    if (prefix.includes("+") && !prefix.includes("-")) {
      added.push({ commit, path, line: next, text: line.slice(parents) });
      next += 1;
    } else if (prefix.trim() === "") {
      next += 1;
    }
  }
  return added;
};

/** Where a finding in a commit's message, author, committer or path list is reported. */
export const COMMIT_METADATA_PATH = "(commit message, author or path)";

/**
 * The lines of `git log --format=%x00%H%n%an%n%ae%n%cn%n%ce%n%B --name-only`'s output, each as an
 * `AddedLine` of its commit at `COMMIT_METADATA_PATH`: what a push publishes besides the patches.
 * Every line but a commit's mark is scanned, so nothing a message holds can hide from it.
 */
export const parseCommitMetadata = (log: string): ReadonlyArray<AddedLine> => {
  const lines: AddedLine[] = [];
  let commit = "";
  let at = 0;
  for (const line of log.split("\n")) {
    if (
      line.startsWith(COMMIT_MARK) &&
      /^[0-9a-f]{40,64}$/.test(line.slice(1))
    ) {
      commit = line.slice(1);
      at = 0;
      continue;
    }
    at += 1;
    if (line.trim() === "") continue;
    lines.push({ commit, path: COMMIT_METADATA_PATH, line: at, text: line });
  }
  return lines;
};

/** The shortest piece of a multi-line value that is recognized on its own (`needlesOf`). */
const PIECE_MIN_LENGTH = 20;

/**
 * Whether `piece` of a multi-line value looks like key material rather than the boilerplate around
 * it: long, and mixing upper case, lower case and digits, as a PEM body line, a base64 blob or a
 * token does — and as `apiVersion: v1` or `"token_uri": "https://oauth2.googleapis.com/token"` do not.
 */
const looksLikeKeyMaterial = (piece: string): boolean =>
  piece.length >= PIECE_MIN_LENGTH &&
  !piece.startsWith("-----") &&
  /[A-Z]/.test(piece) &&
  /[a-z]/.test(piece) &&
  /[0-9]/.test(piece);

/**
 * The texts a stored value is recognized by: the whole value, and for a value of several lines (a
 * PEM key, a kubeconfig, a service account's JSON) each piece of it that looks like key material on
 * its own — split at whitespace, quotes and the `:`, `=`, `,` and `;` around a field, with a JSON
 * string's escaped `\n` read as the line break it is. A boilerplate line such a document shares with
 * every other one is not a piece, so a branch that adds `apiVersion: v1` is not refused for it.
 */
const needlesOf = (
  secrets: InjectedSecrets,
): ReadonlyArray<{ readonly name: string; readonly text: string }> =>
  secrets.flatMap((secret) => {
    const value = Redacted.value(secret.value);
    if (value === "") return [];
    const unescaped = value.replaceAll("\\n", "\n");
    const pieces = unescaped.includes("\n")
      ? unescaped
          .split(/[\s"'`,;:=\\]+/)
          .filter(looksLikeKeyMaterial)
          .filter((piece) => piece !== value)
      : [];
    return [value, ...new Set(pieces)].map((text) => ({
      name: secret.name,
      text,
    }));
  });

/** What a masked part of a finding's path reads as. */
const MASKED = "[secret]";

/** `path` with every stored value and credential shape in it masked: a refusal never quotes one. */
const maskPath = (
  path: string,
  needles: ReadonlyArray<{ readonly text: string }>,
): string => {
  const stored = needles.reduce(
    (masked, needle) => masked.replaceAll(needle.text, MASKED),
    path,
  );
  return SECRET_PATTERNS.reduce(
    (masked, rule) =>
      masked.replace(new RegExp(rule.pattern.source, "g"), MASKED),
    stored,
  );
};

/** Every finding in `lines`: at most one per line, a stored value ahead of a pattern. */
export const scanAddedLines = (
  lines: ReadonlyArray<AddedLine>,
  known: InjectedSecrets,
): ReadonlyArray<SecretFinding> => {
  const needles = needlesOf(known);
  return lines.flatMap((added): ReadonlyArray<SecretFinding> => {
    const where = {
      commit: added.commit,
      path: maskPath(added.path, needles),
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
 * The settings every scan's git runs with, ahead of the subcommand: no hook, no fsmonitor, no quoted
 * paths, no global attributes file and no replacement objects (a `refs/replace` entry would show the
 * scan other bytes than the push sends).
 */
const SCAN_GIT_CONFIG: ReadonlyArray<string> = [
  "--no-replace-objects",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.quotePath=false",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "log.showSignature=false",
];

/** Run one read-only git in `checkout`, answering its stdout or `undefined` when it failed. */
const runScanGit = (
  checkout: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string | undefined> =>
  Effect.callback<string | undefined>((resume, signal) => {
    execFile(
      "git",
      [...SCAN_GIT_CONFIG, ...args],
      {
        cwd: checkout,
        encoding: "utf8",
        signal,
        timeout: SCAN_TIMEOUT_MS,
        maxBuffer: SCAN_MAX_BUFFER,
      },
      (error, stdout) =>
        resume(Effect.succeed(error === null ? stdout : undefined)),
    );
  });

/**
 * Scan the commits `head` holds that `base` and every `exclude` do not, in `checkout` (the session's
 * worktree), answering the refusal when any added line, message, author, committer or path holds a
 * stored value or a credential's shape, and `none` when none does. `base` and `exclude` are refs or
 * commits; the caller decides which ones are trusted to be on the forge already (`./prStep`). A git
 * that cannot answer — a ref that does not resolve, a history past `SCAN_MAX_BUFFER` — is a `PrError`
 * on `secretScan`.
 */
export const scanBranchForSecrets = (input: {
  readonly checkout: string;
  readonly base: string;
  readonly head: string;
  readonly exclude?: ReadonlyArray<string>;
  readonly known: InjectedSecrets;
}): Effect.Effect<Option.Option<SecretFoundPullRequest>, PrError> => {
  const refused = new PrError({
    operation: "secretScan",
    ref: `${input.base}..${input.head}`,
    message:
      "the branch's commits could not be scanned for secrets, so nothing was pushed",
  });
  const range = [
    "--end-of-options",
    input.head,
    ...[input.base, ...(input.exclude ?? [])].map((ref) => `^${ref}`),
    "--",
  ];
  return Effect.gen(function* () {
    const [patches, metadata] = yield* Effect.all(
      [
        runScanGit(input.checkout, [
          "log",
          "--format=%x00%H",
          "-p",
          "-U0",
          "-M",
          // The bytes committed, whatever an attribute says: no binary skip, no textconv, no driver.
          "--text",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          "--no-relative",
          // A merge's own lines, not what it brings from its other parent (`diff --cc`).
          "--diff-merges=dense-combined",
          ...range,
        ]),
        runScanGit(input.checkout, [
          "log",
          "--format=%x00%H%n%an%n%ae%n%cn%n%ce%n%B",
          "--name-only",
          "--no-renames",
          "--no-relative",
          "--diff-merges=dense-combined",
          ...range,
        ]),
      ],
      { concurrency: 2 },
    );
    if (patches === undefined || metadata === undefined) return yield* refused;
    return secretRefusal(
      scanAddedLines(
        [...parseAddedLines(patches), ...parseCommitMetadata(metadata)],
        input.known,
      ),
    );
  }).pipe(Effect.withSpan("secretScan.branch"));
};
