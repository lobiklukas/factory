/**
 * `factory doctor`'s verdicts (LOB-265): which registry rows can cut a worktree, and the fix the
 * others print. The command itself — clone a URL-only repo, report a clone that fails — is proven by
 * `.pi/skills/verify-cli/clone.sh` against a real control plane.
 */
import { Schema } from "effect";
import { RepoSummary } from "@repo/domain/Session";
import { describe, expect, it } from "vitest";
import { diagnoseRow } from "./doctor";

const summary = (
  extra: Partial<typeof RepoSummary.Encoded> = {},
): RepoSummary =>
  Schema.decodeSync(RepoSummary)({
    repo: "acme/x",
    url: "",
    defaultBaseRef: "main",
    registeredAt: "2026-10-28T10:00:00.000Z",
    localPathIsGit: false,
    hasFactoryConfig: false,
    ...extra,
  });

describe("diagnoseRow", () => {
  it("is ok for a checkout inside a git work tree", () => {
    expect(
      diagnoseRow(summary({ localPath: "/src/x", localPathIsGit: true })),
    ).toEqual({ ok: true, detail: "checkout /src/x" });
  });

  it("is ok for a URL-only repo whose clone exists", () => {
    expect(
      diagnoseRow(
        summary({
          url: "https://github.com/acme/x.git",
          mirrorPath: "/s/.cache/acme/x.git",
        }),
      ),
    ).toEqual({ ok: true, detail: "cloned into /s/.cache/acme/x.git" });
  });

  it("fails a checkout that stopped being a work tree, with the path remedy", () => {
    expect(
      diagnoseRow(summary({ localPath: "/gone/x", localPathIsGit: false })),
    ).toEqual({
      ok: false,
      detail: "local checkout is not a git work tree",
      remedy: "factory repo add acme/x --path <dir>",
    });
  });

  it("fails a URL-only repo with no clone, naming the sync", () => {
    expect(
      diagnoseRow(summary({ url: "https://github.com/acme/x.git" })),
    ).toEqual({
      ok: false,
      detail: "not cloned yet",
      remedy: "factory repo sync acme/x",
    });
  });

  it("fails the auto-registered row: no URL and no checkout", () => {
    expect(diagnoseRow(summary())).toEqual({
      ok: false,
      detail: "no clone URL / no local checkout",
      remedy: "factory repo add acme/x --path <dir>",
    });
  });
});
