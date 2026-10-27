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

const fields = (row: string): readonly string[] => row.split(/\s+/);
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

  it("names the missing checkout for a repo with a URL but no path", () => {
    const urlOnly = summary({ localPath: undefined, localPathIsGit: false });
    expect(repoState(urlOnly)).toBe("no local checkout");
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
    expect(lines).toContain("base-ref    main");
    expect(lines).toContain("config      .factory/config found");
    expect(lines).toContain("state       ready");
    // A ready repo needs nothing: no remedy line.
    expect(lines.some((line) => line.startsWith("remedy"))).toBe(false);
  });

  it("says no .factory/config when the checkout declares none", () => {
    expect(repoLines(summary({ hasFactoryConfig: false }))).toContain(
      "config      no .factory/config",
    );
  });

  it("shows an auto-registered repo as no URL / no checkout, with the remedy", () => {
    const lines = repoLines(autoRegistered());
    expect(lines).toContain(`path        ${NONE}`);
    expect(lines).toContain(`url         ${NONE}`);
    expect(lines).toContain("state       no clone URL / no local checkout");
    expect(lines).toContain(
      "remedy      factory repo add acme/auto --path <dir>",
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
    expect(row.endsWith("  ready")).toBe(true);
  });

  it("prints none, not an empty cell, for a repo with no path and no URL", () => {
    const row = repoRow(autoRegistered());
    expect(column(row, "path")).toBe(NONE);
    expect(column(row, "url")).toBe(NONE);
    expect(column(row, "config")).toBe("no");
    expect(row).not.toContain("    ");
    // The state is last and carries the remedy, so the columns before it stay one token each.
    expect(REPO_LS_HEADER.split("  ").at(-1)).toBe("state");
    expect(
      row.endsWith(
        `  no clone URL / no local checkout (${repoRemedy("acme/auto")})`,
      ),
    ).toBe(true);
  });
});
