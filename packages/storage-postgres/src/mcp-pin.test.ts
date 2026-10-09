import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `.mcp.json` pins the version of the package `npx` runs to reach Linear, and the Linear MCP row in
 * `docs/testing-third-parties.md` names the same version (LOB-126).
 *
 * `npx -y mcp-remote <url>` installs whatever the registry calls `latest` on the day an agent starts:
 * nothing in this repo chose that version, and nothing recorded that the one running was the one the
 * row's sources cell cites. There is no integrity hash to check either. Two facts make that worth a
 * guard rather than a comment. First, the package changed hands —
 * `api.github.com/repos/geelen/mcp-remote` now returns `punkpeye/mcp-remote`'s document — so the
 * maintainer every blog post names is no longer the publisher. Second, the whole Linear surface (the
 * loop's issue tracking, its comments, its status moves) arrives through this one process, so a bad
 * release is not a broken tool, it is a loop with no backlog.
 *
 * The pin is `mcp-remote@0.14.3` (MIT, published 2026-09-21, with an npm provenance attestation) as
 * of 2026-10-06; the registry facts and the alternatives (`@automattic/mcp-remote` is a
 * self-described experimental fork whose README says upstream "is no longer actively maintained") are
 * in `.ralph/research/linear-mcp.md`.
 *
 * What this can prove: that the specifier is an exact version rather than a float, that the row in
 * `docs/testing-third-parties.md` names that same version, and that `.pi/mcp.json` still resolves to
 * the root file. What it cannot prove: that the pinned version works, that the registry still serves
 * it, that it is not compromised, or that `npx` resolves the pin the way `npx` documents. Only
 * starting the server does that, and the default gate must never reach Linear
 * (`docs/testing-third-parties.md`). The live half is `pi mcp list`, run by hand on 2026-10-06 and
 * recorded under `.verify/evidence/lob-126/`.
 *
 * The file lives in `@repo/storage-postgres` for the same reason `turbo-env.test.ts`,
 * `ralph-linear-calls.test.ts` and `ralph-docker-env.test.ts` do: it is a repo-level claim that
 * belongs to no package and needs no database and no container to run.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** The authoritative project MCP configuration. */
const MCP_CONFIG = ".mcp.json";

/** pi's project-level MCP path, which this repo keeps as a link rather than a second copy. */
const PI_MCP_CONFIG = ".pi/mcp.json";

/** The link target `PI_MCP_CONFIG` must keep, relative to its own directory. */
const PI_MCP_TARGET = "../.mcp.json";

/** The third-party table whose Linear MCP row records the version. */
const THIRD_PARTIES = "docs/testing-third-parties.md";

/** The MCP server entry whose specifier is pinned. */
const SERVER = "linear";

/** The endpoint that entry reaches, as the row's System cell and `docs/next-agent.md` name it. */
const LINEAR_URL = "https://mcp.linear.app/mcp";

/** The package `npx` runs for that server. */
const PACKAGE = "mcp-remote";

/** A version, and nothing else: `^0.14.3`, `latest` and `0.14` all float. */
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

/**
 * `mcp-remote@0.14.3` inside a table cell. The class stops at the delimiters a cell writes after a
 * version — a backtick, a closing paren, a comma, a semicolon — and `rowPins` strips the sentence
 * punctuation a version written in prose ends with. It cannot simply exclude `.`, because a version
 * is made of dots.
 */
const ROW_PIN = new RegExp(`${PACKAGE}@([^\\s\`),;]+)`, "g");

/** Sentence punctuation a prose version trails, which is not part of the version. */
const TRAILING_PUNCTUATION = /[.:;!?]+$/;

/**
 * A version literal, anywhere in a cell: three components, each at most three digits.
 *
 * The bound is what keeps the sources cell's date out of it — `2026.09.21` is not a version — while
 * still reading `0.14.3`. A version with a four-digit component would not be read, which is a cost
 * this repo's `0.x` pin does not pay.
 */
const VERSION = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;

/**
 * A version written with a range operator — `^0.14.3`, `~0.14.3`, `>=0.14.3` — is an example of a
 * *bad* specifier, not a claim about which version is pinned, and the row has to be able to name one
 * in order to say what it refuses. Without this exclusion the sentence "refuses a floating specifier
 * (`mcp-remote`, `^0.14.3`, `latest`)" reads as "mcp-remote is pinned to 0.14.3", which is a
 * false red on any bump and a false green on a row whose prose happens to match the pin.
 */
const RANGE_OPERATOR = /[\^~<>=]\s*$/;

interface McpServer {
  readonly command?: string;
  readonly args?: readonly string[];
}

interface McpConfig {
  readonly mcpServers?: Record<string, McpServer>;
}

/**
 * What the config asks `npx` for.
 *
 * The three shapes are kept apart because they fail differently and a reader needs to know which one
 * they are looking at: `pinned` is the contract, `floating` is the bug this issue fixes (`npx`
 * resolves `latest`), and `absent` means the guard is reading a config that no longer names the
 * package at all — a rename, or a server reached some other way.
 */
type Specifier =
  | { readonly kind: "pinned"; readonly version: string }
  | { readonly kind: "floating"; readonly text: string }
  | { readonly kind: "absent" };

/** The specifier a config's server entry asks `npx` for, in `args`. */
function specifier(config: McpConfig, server: string): Specifier {
  const args = config.mcpServers?.[server]?.args ?? [];
  for (const arg of args) {
    if (arg === PACKAGE) return { kind: "floating", text: arg };
    if (arg.startsWith(`${PACKAGE}@`)) {
      const version = arg.slice(PACKAGE.length + 1);
      return EXACT_VERSION.test(version)
        ? { kind: "pinned", version }
        : { kind: "floating", text: arg };
    }
  }
  return { kind: "absent" };
}

/**
 * The pin as a plain string, or a thrown reason it is not one. Tests assert through this so a
 * failure names the shape it found rather than reading `undefined`.
 */
function pinOf(config: McpConfig, server: string): string {
  const found = specifier(config, server);
  if (found.kind === "pinned") return found.version;
  if (found.kind === "floating") {
    throw new Error(
      `${MCP_CONFIG}'s ${server} server asks npx for "${found.text}", which is not an exact version`,
    );
  }
  throw new Error(
    `${MCP_CONFIG}'s ${server} server names no ${PACKAGE} specifier`,
  );
}

/** The Linear MCP row of the third-party table, as the single line markdown writes it on. */
function linearRow(markdown: string): string {
  const row = markdown
    .split("\n")
    .find((line) => line.startsWith("| Linear MCP server"));
  if (row === undefined) {
    throw new Error(`${THIRD_PARTIES} has no "| Linear MCP server" row`);
  }
  return row;
}

/** Every `mcp-remote@<version>` the row names, in order, without the punctuation after it. */
function rowPins(row: string): string[] {
  return [...row.matchAll(ROW_PIN)].map((match) =>
    (match[1] ?? "").replace(TRAILING_PUNCTUATION, ""),
  );
}

/**
 * Every version named in a cell that mentions the package, range-qualified examples excluded.
 *
 * The row states the pin in two shapes: `mcp-remote@0.14.3` in the strategy cell, and, in the sources
 * cell, a version in parentheses after a link whose URL is the package name — the shipped row writes
 * `(0.14.3, MIT, 2026-09-21)` after the `mcp-remote` registry link. The first is what `rowPins`
 * reads; this reader is the one that also reads the second, and the one the bump procedure's "two
 * places" names. The system cell deliberately names no version, so it cannot go stale on a bump.
 *
 * Cell-scoped rather than window-scoped is the point: a distance rule has to guess how close a
 * version must sit to belong to a mention, and both guesses are wrong. A stale number further along
 * the sources cell than the guess is missed, and a citation moved *before* its link sits at distance
 * zero, so it drifts with no window to catch it. A cell is the unit markdown already gives the row,
 * and a cell that talks about the package may name exactly one version: the pin.
 *
 * The cost of the wider rule is a false red a distance rule would miss: a cell naming both this
 * package and another package's version reads both. The shipped row does not (the tool cell names
 * `@modelcontextprotocol/server` 2.3.1 and no `mcp-remote`). `VERSION` is bounded to three components
 * of at most three digits each so the sources cell's date cannot read as a version — a dotted
 * `2026.09.21` would otherwise count, and a version with a four-digit component would not be read;
 * this package's `0.x` line has none.
 */
function cellVersions(row: string): string[] {
  const out: string[] = [];
  for (const cell of row.split("|")) {
    if (!cell.includes(PACKAGE)) continue;
    for (const version of cell.matchAll(VERSION)) {
      const before = cell.slice(0, version.index);
      if (RANGE_OPERATOR.test(before)) continue;
      out.push(version[0]);
    }
  }
  return out;
}

const read = (relative: string): string =>
  readFileSync(path.join(REPO_ROOT, relative), "utf8");

const config = (text: string): McpConfig => JSON.parse(text) as McpConfig;

/** The repo's own pin, read once: the thing every other case is measured against. */
const CONFIGURED = specifier(config(read(MCP_CONFIG)), SERVER);

/**
 * That pin as a plain string, or `""` when the config pins nothing.
 *
 * Deliberately not a throw: a config with no pin is a *result to assert on*, so the case that owns
 * that failure can name it and the other cases still run and report their own verdicts. A
 * module-level throw would abort the file and tell a reader only that something, somewhere, is
 * wrong.
 */
const PIN = CONFIGURED.kind === "pinned" ? CONFIGURED.version : "";

describe("the mcp-remote pin", () => {
  // Mutation checked: dropping the `@0.14.3` from `.mcp.json`'s `linear.args`, which is the exact
  // pre-LOB-126 text. `specifier` reads it as `floating`, so this case reddens naming the bare
  // specifier; the row case below reddens on the same edit through its own comparison.
  it("pins an exact version in .mcp.json", () => {
    expect(
      CONFIGURED.kind,
      `${MCP_CONFIG}'s ${SERVER} server must ask npx for an exact ${PACKAGE} version`,
    ).toBe("pinned");
    // No second assertion on `PIN`'s shape: `specifier` only answers `pinned` after `EXACT_VERSION`
    // has matched, so one here would be dominated by the line above. The boundary itself is the
    // refusal case below, which every float in this file's list reddens.
  });

  // Mutation checked: `args` reordered to `["-y", "https://mcp.linear.app/mcp", "mcp-remote@0.14.3"]`,
  // where `npx` runs the URL as the command, and `"command": "bunx"`. Both were green against the
  // cases above — `specifier` scans every argument and never reads `command`, so it still answered
  // `pinned 0.14.3` — and both redden here. `docs/next-agent.md` writes this line as
  // `npx -y mcp-remote@<exact version>`, the shipped config is that line with the version filled in,
  // and `pi mcp list` prints it back resolved.
  it("runs the pin through `npx -y`, the command line the docs print", () => {
    const entry = config(read(MCP_CONFIG)).mcpServers?.[SERVER];
    expect(entry?.command, `${MCP_CONFIG}'s ${SERVER} server runs npx`).toBe(
      "npx",
    );
    const args = entry?.args ?? [];
    const spec = args.indexOf(`${PACKAGE}@${PIN}`);
    expect(
      spec,
      `the args carry the pinned specifier: ${args.join(" ")}`,
    ).toBeGreaterThan(-1);
    // The first argument that is not a flag is the package npx executes, so the flag that answers
    // its install prompt has to come first — `npx` asks before it installs, and nothing in a ralph
    // session is there to answer. What follows the specifier is the endpoint, not a second package
    // npx would ignore.
    expect(args.slice(0, spec), "npx's own flags, then the package").toEqual([
      "-y",
    ]);
    expect(args.slice(spec + 1), "then the endpoint").toEqual([LINEAR_URL]);
  });

  // Mutation checked: bumping one side only — `.mcp.json` to another version while the row keeps
  // this one, or the row edited to another version while the config keeps this one. Both are the
  // drift the row's own sentence claims a test catches.
  it("names the same version in the Linear MCP row", () => {
    const row = linearRow(read(THIRD_PARTIES));
    const named = rowPins(row);
    expect(named.length, "the row names a pinned version").toBeGreaterThan(0);
    expect([...new Set(named)]).toEqual([PIN]);
    // The sources cell's citation is a version of the same package, so it drifts the same way.
    expect([...new Set(cellVersions(row))]).toEqual([PIN]);
  });

  // Mutation checked: replacing the link with a real file — a copy of `.mcp.json`, which then drifts
  // silently — or pointing it at a different config. The row's "single source of truth" sentence and
  // `docs/next-agent.md`'s answer to "which file is authoritative" both rest on this being a link.
  it("keeps .pi/mcp.json a link to the root config", () => {
    const link = path.join(REPO_ROOT, PI_MCP_CONFIG);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(PI_MCP_TARGET);
    // Those two lines also settle that the link is live: reading the project path resolves through
    // the target asserted above, so the text pi reads is the text this file just pinned. Asserting
    // the read as well would be dominated by them and could never be the line that fails.
  });

  // Mutation checked: making `specifier` accept any `mcp-remote@`-prefixed argument, which would
  // read a range or a dist-tag as a pin. `npx` resolves all three to a floating version.
  it("refuses a specifier that is not an exact version", () => {
    const configOf = (arg: string): McpConfig => ({
      mcpServers: { [SERVER]: { command: "npx", args: ["-y", arg, "url"] } },
    });
    for (const floating of [
      PACKAGE,
      `${PACKAGE}@^0.14.3`,
      `${PACKAGE}@~0.14.3`,
      `${PACKAGE}@latest`,
      `${PACKAGE}@0.14`,
      `${PACKAGE}@>=0.14.3`,
    ]) {
      expect(specifier(configOf(floating), SERVER), floating).toEqual({
        kind: "floating",
        text: floating,
      });
      expect(() => pinOf(configOf(floating), SERVER)).toThrow(
        /not an exact version/,
      );
    }

    // The positive control: the pinned form is accepted, and only it.
    expect(specifier(configOf(`${PACKAGE}@0.14.3`), SERVER)).toEqual({
      kind: "pinned",
      version: "0.14.3",
    });
    expect(specifier(configOf("other-package@0.14.3"), SERVER)).toEqual({
      kind: "absent",
    });
  });

  // Mutation checked: widening `EXACT_VERSION` to a loose version match — `\d+\.\d+`, or a suffix
  // the reader does not check. The boundary is narrow on purpose: a leading `v`, a prerelease and
  // build metadata all resolve to an *exact* version under npm's own rules, so this reader refuses
  // three shapes that are arguably pins. That is the conservative side of the line, it fails loud
  // and names the text it found, and no pin in this repo has needed one; widening `EXACT_VERSION`
  // to accept them is a deliberate change that has to update this case with it.
  it("reads three dot-separated numbers as the pin, and every other suffix as a float", () => {
    const configOf = (args: string[]): McpConfig => ({
      mcpServers: { [SERVER]: { command: "npx", args } },
    });
    for (const notExact of [
      `${PACKAGE}@v0.14.3`,
      `${PACKAGE}@0.14.3-alpha.1`,
      `${PACKAGE}@0.14.3+build`,
      `${PACKAGE}@0.14.3.4`,
      `${PACKAGE}@0.14.3 `,
      `${PACKAGE}@ 0.14.3`,
      `${PACKAGE}@"0.14.3"`,
    ]) {
      expect(
        specifier(configOf(["-y", notExact, "url"]), SERVER),
        notExact,
      ).toEqual({ kind: "floating", text: notExact });
    }

    // A version in an argument of its own is an argument for the package, not a specifier for it:
    // `npx -y mcp-remote 0.14.3` installs the registry's `latest` and hands it `0.14.3` as argv.
    expect(specifier(configOf(["-y", PACKAGE, "0.14.3"]), SERVER)).toEqual({
      kind: "floating",
      text: PACKAGE,
    });
  });

  // Mutation checked: widening `rowPins` to any `@version` in the row — the row also names
  // `@modelcontextprotocol/server` 2.3.1, so a rule that does not tie the version to the package
  // reads the wrong one — or dropping the `TRAILING_PUNCTUATION` strip, so a pin written outside
  // backticks at the end of a sentence reads as `0.14.3.`. (`ROW_PIN`'s own delimiter class is not
  // exercised here: every input below is stopped by a backtick or a space first.)
  it("reads the pinned specifier out of the row, and no other package's version", () => {
    expect(rowPins("| x | pins `mcp-remote@0.14.3` (MIT) |")).toEqual([
      "0.14.3",
    ]);
    expect(
      rowPins(
        "| x | `mcp-remote` registry (0.14.3) and `@modelcontextprotocol/server` 2.3.1 |",
      ),
    ).toEqual([]);
    expect(
      rowPins("| x | pins `mcp-remote@0.14.3`, sources (0.14.3, MIT) |"),
    ).toEqual(["0.14.3"]);
    // The delimiter class stops at sentence punctuation, so a row that writes the pin in prose
    // rather than in backticks still reads the version and not the full stop after it.
    expect(rowPins("| x | the pin is mcp-remote@0.14.3. See below. |")).toEqual(
      ["0.14.3"],
    );
    expect(rowPins("| x | pinned: mcp-remote@0.14.3? yes |")).toEqual([
      "0.14.3",
    ]);
  });

  // Mutation checked: bumping `.mcp.json` and both places the bump procedure names to `0.15.0`
  // while a stale `0.14.3` stays in the sources cell's prose, further along that cell than any
  // distance rule would look — measured green against a window-scoped reader, which is why this one
  // is cell-scoped — or moving the citation *before* its link, where the distance is zero.
  it("names no other version in a cell that talks about the package", () => {
    const row = linearRow(read(THIRD_PARTIES));
    expect(
      cellVersions(row).length,
      "the row's cells name the pin, so the comparisons below are not vacuous",
    ).toBeGreaterThan(0);
    expect([...new Set(cellVersions(row))]).toEqual([PIN]);
    // Exactly two cells name it — the strategy cell and the sources cell — which is what
    // `docs/next-agent.md`'s "the two places ... that the guard reads" promises. A third one would
    // make a bump that missed it go stale silently, so the promise is asserted rather than assumed.
    expect(
      row.split("|").filter((cell) => cellVersions(`|${cell}|`).length > 0)
        .length,
      "the version-bearing cells the bump procedure names",
    ).toBe(2);

    // The sources-cell shape: the mention is the link's URL, the version follows its paren, and the
    // reader counts the version once however many times the cell names the package.
    expect(
      cellVersions(
        "| x | [`mcp-remote` registry](https://registry.npmjs.org/mcp-remote) (0.14.3, MIT, 2026-09-21) |",
      ),
    ).toEqual(["0.14.3"]);
    // A cell that names the package twice, once correctly and once stale, is read as both — the
    // drift a distance rule cannot see once the stale number sits past its window.
    expect(
      cellVersions(
        "| x | pins `mcp-remote@0.15.0`; the hand-run `pi mcp list` printed 0.14.3 |",
      ),
    ).toEqual(["0.15.0", "0.14.3"]);
    // And the same citation moved before its link drifts with no distance at all.
    expect(
      cellVersions(
        "| x | (0.15.0, MIT) [`mcp-remote` registry](https://registry.npmjs.org/mcp-remote) |",
      ),
    ).toEqual(["0.15.0"]);
    // A cell that does not name the package is not read at all, so the neighbouring package's
    // version is not this package's: the row's tool cell names `@modelcontextprotocol/server`
    // 2.3.1 and no `mcp-remote`.
    expect(
      cellVersions("| x | route is `@modelcontextprotocol/server` 2.3.1 |"),
    ).toEqual([]);
    // A range is an example the row refuses, not a version it names.
    expect(
      cellVersions(
        "| x | refuses a floating specifier (`mcp-remote`, `^0.14.3`, `~0.13.0`, `>=0.14.0`, `latest`) |",
      ),
    ).toEqual([]);
    // And a date is not a version: the sources cell carries one, and a dotted date in a cell that
    // mentions the package must not read as a second pin. The shipped row writes it `2026-09-21`.
    expect(
      cellVersions(
        "| x | [`mcp-remote` registry](https://registry.npmjs.org/mcp-remote) (0.14.3, MIT, 2026.09.21) |",
      ),
    ).toEqual(["0.14.3"]);
    expect(cellVersions("| x | `mcp-remote` released 2026.09.21 |")).toEqual(
      [],
    );
    // The positive control: the same version without the operator is a pin.
    expect(cellVersions("| x | `mcp-remote` registry (0.14.3, MIT) |")).toEqual(
      ["0.14.3"],
    );
  });

  // Mutation checked: deleting the "| Linear MCP server" row, renaming it, or dropping the pin
  // sentence from it. `linearRow` throws on the first two; the case above reddens on the third.
  it("finds the row it claims to check", () => {
    const row = linearRow(read(THIRD_PARTIES));
    // Without this, `toContain(PIN)` below is `toContain("")` on a config that pins nothing, which
    // passes and says nothing.
    expect(PIN, "a pinned version, or the row check proves nothing").not.toBe(
      "",
    );
    expect(row).toContain(PACKAGE);
    expect(row).toContain(PIN);
    expect(() =>
      linearRow("| System | Strategy |\n| ------ | -------- |\n"),
    ).toThrow(/no "\| Linear MCP server" row/);
  });
});
