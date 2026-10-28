import { Redacted } from "effect";
import { describe, expect, it } from "vitest";
import type { SecretSummary } from "@repo/domain/Secret";
import { RepoSlug } from "@repo/domain/Session";
import {
  EMPTY_SECRET_FORM,
  secretInput,
  secretRefusal,
  secretsOf,
} from "./secrets-view";

const repo = RepoSlug.make("acme/widgets");
const summary = (name: string, of = repo): SecretSummary => ({
  repo: of,
  name,
  createdAt: "2026-10-28T10:00:00.000Z",
  updatedAt: "2026-10-28T10:00:00.000Z",
  updatedBy: "",
});

describe("secretsOf", () => {
  it("keeps one repo's secrets, by name", () => {
    expect(
      secretsOf(
        [summary("ZED"), summary("ALPHA", RepoSlug.make("acme/other")), summary("ABLE")],
        repo,
      ).map((secret) => secret.name),
    ).toEqual(["ABLE", "ZED"]);
  });
});

describe("secretInput", () => {
  it("sends the upper-cased name and the value as typed, redacted", () => {
    const parsed = secretInput(repo, {
      name: " test_api_key ",
      value: "fake-value-1234",
    });
    if (!parsed.ok) throw new Error(parsed.problem);
    expect(parsed.input.name).toBe("TEST_API_KEY");
    expect(Redacted.value(parsed.input.value)).toBe("fake-value-1234");
    // A redacted value does not print.
    expect(String(parsed.input.value)).not.toContain("fake-value-1234");
  });

  it("refuses a name that is no variable and a value shorter than the minimum", () => {
    expect(secretInput(repo, { name: "1BAD", value: "fake-value-1234" }).ok).toBe(
      false,
    );
    expect(secretInput(repo, { ...EMPTY_SECRET_FORM, name: "OK" }).ok).toBe(false);
    expect(secretInput(repo, { name: "OK", value: "short" }).ok).toBe(false);
  });
});

describe("secretRefusal", () => {
  it("shows the server's words, else the fallback", () => {
    expect(
      secretRefusal({ _tag: "SecretsUnconfigured", message: "no key" }, "x"),
    ).toBe("no key");
    expect(secretRefusal(undefined, "dropped")).toBe("dropped");
  });
});
