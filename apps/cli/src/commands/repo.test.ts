/**
 * `factory repo`'s rendering (LOB-253): what a registry row says in `add`/`show` and in `ls`.
 *
 * The commands themselves are proven by `.pi/skills/verify-cli/repo.sh`, which runs them in a
 * terminal against a real control plane. These cases are the ones a pane capture would not
 * localize: which field the path lands in, that a missing value is a word rather than an empty
 * cell, and that a row no session can cut a worktree from says why and names the fix.
 */
import { Schema } from "effect";
import { RepoSummary } from "@repo/domain/Session";
import { describe, expect, it } from "vitest";
import {
  NONE,
  REPO_LS_HEADER,
  repoLines,
  repoRemedy,
  repoRow,
  repoState,
} from "./repo";

const summary = (
  extra: Partial<typeof RepoSummary.Encoded> = {},
): RepoSummary =>
  Schema.decodeSync(RepoSummary)({
    repo: "acme/x",
    url: "https://example.invalid/acme/x.git",
    defaultBaseRef: "main",
    localPath: "/tmp/x",
    registeredAt: "2026-10-28T10:00:00.000Z",
    localPathIsGit: true,
    hasFactoryConfig: true,
    workTree: "/tmp/x",
    ...extra,
  });

/** The row `createSession` writes the first time a session names a slug. */
const autoRegistered = (): RepoSummary =>
  Schema.decodeSync(RepoSummary)({
    repo: "acme/auto",
    url: "",
    defaultBaseRef: "main",
    registeredAt: "2026-10-28T10:00:00.000Z",
    localPathIsGit: false,
    hasFactoryConfig: false,
  });

const fields = (row: string): readonly string[] => row.split("\t");
const column = (row: string, name: string): string | undefined =>
  fields(row)[fields(REPO_LS_HEADER).indexOf(name)];

describe("repoState", () => {
  it("is ready for a checkout inside a git work tree", () => {
    expect(repoState(summary())).toBe("ready");
  });

  it("names both halves for a repo a session auto-registered", () => {
    expect(repoState(autoRegistered())).toBe(
      "no clone URL / no local checkout",
    );
  });

  it("says a repo with a URL but no path is not cloned yet", () => {
    const urlOnly = summary({ localPath: undefined, localPathIsGit: false });
    expect(repoState(urlOnly)).toBe("not cloned yet");
  });

  it("is ready for a URL-only repo the factory has cloned into its cache (LOB-265)", () => {
    const cloned = summary({
      localPath: undefined,
      localPathIsGit: false,
      mirrorPath: "/sessions/.cache/acme/x.git",
    });
    expect(repoState(cloned)).toBe("ready");
  });

  it("says a registered path is no longer a work tree", () => {
    expect(repoState(summary({ localPathIsGit: false }))).toBe(
      "local checkout is not a git work tree",
    );
  });
});

describe("repoLines", () => {
  it("prints the repo, path, base ref and whether .factory/config was found", () => {
    const lines = repoLines(summary());
    expect(lines).toContain("repo        acme/x");
    expect(lines).toContain("path        /tmp/x");
    expect(lines).toContain("work-tree   /tmp/x");
    expect(lines).toContain("base-ref    main");
    expect(lines).toContain("config      .factory/config found");
    expect(lines).toContain("state       ready");
    // A ready repo needs nothing: no remedy line.
    expect(lines.some((line) => line.startsWith("remedy"))).toBe(false);
  });

  it("names the enclosing work tree a path inside a checkout is cut from", () => {
    const nested = summary({
      localPath: "/tmp/x/packages/y",
      workTree: "/tmp/x",
    });
    expect(repoLines(nested)).toContain("work-tree   /tmp/x");
  });

  it("says no .factory/config when the checkout declares none", () => {
    expect(repoLines(summary({ hasFactoryConfig: false }))).toContain(
      "config      no .factory/config",
    );
  });

  it("shows an auto-registered repo as no URL / no checkout, with the remedy", () => {
    const lines = repoLines(autoRegistered());
    expect(lines).toContain(`path        ${NONE}`);
    expect(lines).toContain(`work-tree   ${NONE}`);
    expect(lines).toContain(`url         ${NONE}`);
    expect(lines).toContain("state       no clone URL / no local checkout");
    expect(lines).toContain(
      "remedy      factory repo add acme/auto --path <dir>",
    );
  });
});

describe("a URL-only repo", () => {
  const urlOnly = (extra: Partial<typeof RepoSummary.Encoded> = {}) =>
    summary({ localPath: undefined, localPathIsGit: false, ...extra });

  it("names the clone as the remedy, not a path", () => {
    const lines = repoLines(urlOnly());
    expect(lines).toContain("state       not cloned yet");
    expect(lines).toContain("remedy      factory repo sync acme/x");
    expect(lines).toContain(`cache       ${NONE}`);
  });

  it("prints its cache and no remedy once cloned", () => {
    const lines = repoLines(urlOnly({ mirrorPath: "/s/.cache/acme/x.git" }));
    expect(lines).toContain("cache       /s/.cache/acme/x.git");
    expect(lines).toContain("state       ready");
    expect(lines.some((line) => line.startsWith("remedy"))).toBe(false);
  });

  it("carries the sync remedy in the ls state column", () => {
    expect(column(repoRow(urlOnly()), "state")).toBe(
      "not cloned yet (factory repo sync acme/x)",
    );
  });
});

describe("repoRow", () => {
  it("puts each value under its header, the path second", () => {
    const row = repoRow(summary());
    expect(column(row, "repo")).toBe("acme/x");
    expect(column(row, "path")).toBe("/tmp/x");
    expect(column(row, "base-ref")).toBe("main");
    expect(column(row, "registered-at")).toBe("2026-10-28T10:00:00.000Z");
    expect(column(row, "config")).toBe("yes");
    expect(column(row, "url")).toBe("https://example.invalid/acme/x.git");
    expect(column(row, "state")).toBe("ready");
  });

  it("keeps a path and a URL with spaces in one column each", () => {
    const row = repoRow(
      summary({
        localPath: "/Users/me/My Repos/x",
        url: "file:///Users/me/My Repos/x",
      }),
    );
    expect(column(row, "path")).toBe("/Users/me/My Repos/x");
    expect(column(row, "base-ref")).toBe("main");
    expect(column(row, "url")).toBe("file:///Users/me/My Repos/x");
    expect(fields(row)).toHaveLength(fields(REPO_LS_HEADER).length);
  });

  it("prints none, not an empty cell, for a repo with no path and no URL", () => {
    const row = repoRow(autoRegistered());
    expect(column(row, "path")).toBe(NONE);
    expect(column(row, "url")).toBe(NONE);
    expect(column(row, "config")).toBe("no");
    expect(fields(row).every((cell) => cell !== "")).toBe(true);
    // The state carries the remedy in the last column.
    expect(fields(REPO_LS_HEADER).at(-1)).toBe("state");
    expect(column(row, "state")).toBe(
      `no clone URL / no local checkout (${repoRemedy("acme/auto")})`,
    );
  });
});
