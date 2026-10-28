/**
 * `factory secret`'s rendering (S-agent-secrets). The commands themselves are proven by
 * `.pi/skills/verify-api/secrets.sh` against a real control plane; these cases pin what a row and a
 * set print — never a value — and how a value read from stdin loses its line ending.
 */
import type { SecretSummary } from "@repo/domain/Secret";
import { RepoSlug } from "@repo/domain/Session";
import { describe, expect, it } from "vitest";
import {
  NONE,
  SECRET_LS_HEADER,
  secretLsLines,
  secretRow,
  secretSetLines,
  secretValueOf,
} from "./secret";

const summary = (extra: Partial<SecretSummary> = {}): SecretSummary => ({
  repo: RepoSlug.make("acme/widgets"),
  name: "TEST_API_KEY",
  createdAt: "2026-10-28T10:00:00.000Z",
  updatedAt: "2026-10-28T11:00:00.000Z",
  updatedBy: "person:ada",
  ...extra,
});

describe("factory secret's lines", () => {
  it("lists repo, name, when and who, tab-separated", () => {
    expect(secretLsLines([summary(), summary({ updatedBy: "" })])).toEqual([
      SECRET_LS_HEADER,
      "acme/widgets\tTEST_API_KEY\t2026-10-28T11:00:00.000Z\tperson:ada",
      `acme/widgets\tTEST_API_KEY\t2026-10-28T11:00:00.000Z\t${NONE}`,
    ]);
    expect(secretLsLines([])).toEqual(["no secrets"]);
    expect(secretRow(summary()).split("\t")).toHaveLength(4);
  });

  it("says what was set and that the value is not shown", () => {
    const lines = secretSetLines(summary());
    expect(lines[0]).toBe("set          acme/widgets TEST_API_KEY");
    expect(lines).toContain(
      "value        not shown: a secret is never answered back",
    );
  });

  it("drops one trailing line ending from a value read from stdin, and nothing else", () => {
    expect(secretValueOf("fake-value-1234\n")).toBe("fake-value-1234");
    expect(secretValueOf("fake-value-1234\r\n")).toBe("fake-value-1234");
    expect(secretValueOf("line one\nline two\n\n")).toBe(
      "line one\nline two\n",
    );
    expect(secretValueOf("  spaced  ")).toBe("  spaced  ");
  });
});
