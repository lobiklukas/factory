/**
 * `factory status` and the faux warning of `factory run` (LOB-272): what each prints for a given
 * `getServerInfo` answer.
 *
 * The commands are proven by `.pi/skills/verify-cli` against a real control plane; these are the
 * cases a pane capture would not localize — which fact lands on which line, and that nothing
 * secret-shaped is invented.
 */
import { Schema } from "effect";
import { ServerInfo } from "@repo/domain/Server";
import { describe, expect, it } from "vitest";
import { fauxWarning, statusLines } from "./status";

const FAUX_WARNING =
  "sessions run against the faux provider and produce scripted answers (chosen by MODEL_BACKEND=faux)";

const faux = (extra: Partial<typeof ServerInfo.Encoded> = {}): ServerInfo =>
  Schema.decodeSync(ServerInfo)({
    backend: "faux",
    selectedBy: "MODEL_BACKEND",
    reason: "model backend: faux (selected by MODEL_BACKEND)",
    warnings: [FAUX_WARNING],
    defaultModel: "faux/faux-1",
    roleModels: [{ role: "specifier", model: "faux/faux-spec" }],
    models: ["faux/faux-1", "faux/faux-2"],
    approvalRequired: ["npm publish"],
    defaultBudget: 3,
    credentialMode: { model: null, forge: "none", reviewer: "none" },
    webhooks: [
      { route: "github", armed: true, variable: "GITHUB_WEBHOOK_SECRET" },
      { route: "linear", armed: false, variable: "LINEAR_WEBHOOK_SECRET" },
    ],
    linearWriteBack: { enabled: false },
    sandbox: "in-process",
    ...extra,
  });

const anthropic = (): ServerInfo =>
  faux({
    backend: "anthropic",
    selectedBy: "credential",
    reason: "model backend: anthropic (credential ANTHROPIC_API_KEY)",
    warnings: [],
    defaultModel: "anthropic/claude-sonnet-5-5",
    credentialMode: {
      model: { source: "ANTHROPIC_API_KEY", type: "api_key" },
      forge: "static-token",
      reviewer: "token",
    },
    linearWriteBack: {
      enabled: true,
      states: { started: "In Progress", inReview: "In Review", done: "Done" },
    },
  });

describe("fauxWarning", () => {
  /** Mutation: return the warning whatever the backend, or never. */
  it("is `warning: faux backend` on a faux server, carrying the server's own reason", () => {
    const warning = fauxWarning(faux());
    expect(warning?.startsWith("warning: faux backend")).toBe(true);
    expect(warning).toContain(FAUX_WARNING);
  });

  it("is absent on an anthropic server", () => {
    expect(fauxWarning(anthropic())).toBeUndefined();
  });

  it("still warns when the server sent no reason", () => {
    expect(fauxWarning(faux({ warnings: [] }))).toBe(
      "warning: faux backend, sessions do not reach a real model",
    );
  });
});

describe("statusLines", () => {
  const lines = (info: ServerInfo) => statusLines(info);

  /** Mutation: print the backend but not what chose it. */
  it("names the backend and the reason it was chosen, first", () => {
    const [backend, selectedBy, reason] = lines(faux());
    expect(backend).toBe("backend faux");
    expect(selectedBy).toBe("selected-by MODEL_BACKEND");
    expect(reason).toBe(
      "reason model backend: faux (selected by MODEL_BACKEND)",
    );
    expect(lines(anthropic())[1]).toBe("selected-by credential");
  });

  it("prints the boot's warnings, the models and the gate", () => {
    const out = lines(faux());
    expect(out).toContain(`warning ${FAUX_WARNING}`);
    expect(out).toContain("default-model faux/faux-1");
    expect(out).toContain("role-model specifier faux/faux-spec");
    expect(out).toContain("models faux/faux-1, faux/faux-2");
    expect(out).toContain("approval-required npm publish");
    expect(out).toContain("default-budget $3.0000");
  });

  /** Mutation: print `undefined` or an empty value where nothing is set. */
  it("says `none` where nothing is set, never an empty value", () => {
    const out = lines(
      faux({
        warnings: [],
        roleModels: [],
        approvalRequired: [],
        defaultBudget: undefined,
      }),
    );
    expect(out).toContain("approval-required none");
    expect(out).toContain("default-budget none");
    expect(out.some((line) => line.startsWith("warning"))).toBe(false);
    expect(out.some((line) => line.startsWith("role-model"))).toBe(false);
    expect(out.some((line) => /\s$|undefined/.test(line))).toBe(false);
  });

  it("prints the credential modes, as modes", () => {
    const out = lines(anthropic());
    expect(out).toContain("model-credential ANTHROPIC_API_KEY (api_key)");
    expect(out).toContain("forge-credential static-token");
    expect(out).toContain("reviewer-credential token");
    expect(lines(faux())).toContain("model-credential none");
  });

  /** Mutation: print every route as armed, or drop the variable's name. */
  it("prints each webhook route, armed or not, with the variable that arms it", () => {
    const out = lines(faux());
    expect(out).toContain("webhook github armed (GITHUB_WEBHOOK_SECRET)");
    expect(out).toContain("webhook linear unarmed (LINEAR_WEBHOOK_SECRET)");
  });

  it("prints the Linear write-back with its states when it is on", () => {
    expect(lines(faux())).toContain("linear-write-back off");
    expect(lines(anthropic())).toContain(
      "linear-write-back on (started In Progress, in review In Review, done Done)",
    );
    expect(lines(faux())).toContain("sandbox in-process");
  });
});
