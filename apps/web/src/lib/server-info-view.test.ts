/**
 * The backend banner's rule and the session model label (LOB-272). Rendering is proven in a browser
 * by `.pi/skills/verify-web` (`features/backend-badge.md`); these are the cases it does not reach:
 * the backends that must not warn, and a session whose row names no model.
 */
import { Schema } from "effect";
import { ServerInfo } from "@repo/domain/Server";
import { describe, expect, it } from "vitest";
import { FAUX_BANNER, backendBanner, sessionModel } from "./server-info-view";

const info = (backend: "faux" | "anthropic"): ServerInfo =>
  Schema.decodeSync(ServerInfo)({
    backend,
    selectedBy: backend === "faux" ? "MODEL_BACKEND" : "credential",
    reason:
      backend === "faux"
        ? "model backend: faux (selected by MODEL_BACKEND)"
        : "model backend: anthropic (credential ANTHROPIC_API_KEY)",
    warnings: [],
    defaultModel:
      backend === "faux" ? "faux/faux-1" : "anthropic/claude-sonnet-5-5",
    roleModels: [],
    models: [],
    approvalRequired: [],
    credentialMode: { model: null, forge: "none", reviewer: "none" },
    webhooks: [],
    linearWriteBack: { enabled: false },
    sandbox: "in-process",
  });

describe("backendBanner", () => {
  /** Mutation: warn on every backend, or on none. */
  it("warns under faux, in the words the issue names, with the server's reason", () => {
    const banner = backendBanner(info("faux"));
    expect(banner?.message).toBe(FAUX_BANNER);
    expect(FAUX_BANNER).toBe(
      "Scripted model (faux): sessions do not reach a real model. Set ANTHROPIC_API_KEY in the repo-root .env and restart.",
    );
    expect(banner?.reason).toBe(
      "model backend: faux (selected by MODEL_BACKEND)",
    );
  });

  it("does not warn under anthropic", () => {
    expect(backendBanner(info("anthropic"))).toBeNull();
  });

  /** Mutation: treat an unread answer as faux, which flashes the banner on every load. */
  it("does not warn before the control plane has answered", () => {
    expect(backendBanner(undefined)).toBeNull();
  });
});

describe("sessionModel", () => {
  it("is the recorded provider/model", () => {
    expect(sessionModel("anthropic/claude-sonnet-5-5")).toBe(
      "anthropic/claude-sonnet-5-5",
    );
  });

  /** Mutation: fall back to the deployment's default, which names the wrong model for a replay. */
  it("is null for a row that names no model", () => {
    expect(sessionModel(undefined)).toBeNull();
    expect(sessionModel("")).toBeNull();
  });
});
