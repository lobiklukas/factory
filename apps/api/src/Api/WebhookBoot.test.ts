/* oxlint-disable effecttsgo/process-env */
/**
 * What the boot says about trigger configuration (LOB-266), captured from the log the process
 * writes: the decode error for a malformed `TRIGGER_RULES`, the rules a valid one mapped, and one
 * line per webhook route saying armed or unarmed.
 *
 * `logTriggerBoot` is the effect `index.ts` runs, over an environment record rather than the
 * process's, so a case sets exactly the variables it means. The log is read through a recording
 * logger — the line an operator greps is what is asserted, not a helper's return value — and every
 * secret below is a canary no line may contain: only whether a secret is set is ever logged.
 *
 * Mutations these cases catch: swallowing a malformed value into `[]` again (the refusal and the
 * error line go), logging the rules without their repos, a route missing from the table or reported
 * armed with its variable unset, a blank secret counted as armed (the route answers `503` for it),
 * and a secret's value in the log.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Logger } from "effect";
import { describe, expect, it } from "vitest";
import {
  bootEnvFromProcess,
  describeWebhookRoutes,
  logTriggerBoot,
  readTriggerRules,
  TRIGGER_RULES_VARIABLE,
  WEBHOOK_ROUTES,
  type Env,
} from "./WebhookBoot";

const CANARY = "lob266-secret-canary-do-not-log";

type Line = { readonly level: string; readonly text: string };

/** Run the boot over `env`, answering its exit and every line it logged. */
const boot = async (env: Env) => {
  const lines: Array<Line> = [];
  const recording = Logger.make(({ message, logLevel }) => {
    lines.push({
      level: logLevel,
      text: (Array.isArray(message) ? message : [message])
        .map(String)
        .join(" "),
    });
  });
  const exit = await Effect.runPromiseExit(
    logTriggerBoot(env).pipe(Effect.provide(Logger.layer([recording]))),
  );
  return { exit, lines };
};

const ALL_ARMED: Env = {
  LINEAR_WEBHOOK_SECRET: CANARY,
  TRIGGER_SECRET: CANARY,
  SENTRY_CLIENT_SECRET: CANARY,
  GITHUB_WEBHOOK_SECRET: CANARY,
};

describe("TRIGGER_RULES at boot", () => {
  it("logs the decode error naming the variable, and refuses the boot, for a rule that is not one", async () => {
    const { exit, lines } = await boot({
      ...ALL_ARMED,
      TRIGGER_RULES: '[{"label":1}]',
    });

    expect(exit._tag).toBe("Failure");
    const error = lines.find((line) => line.level === "Error");
    expect(error?.text).toContain("TRIGGER_RULES");
    // The decode message, which says what is wrong with the entry: the label is not a string, and
    // the repo and prompt are missing.
    expect(error?.text).toMatch(/label/);
    expect(error?.text).toMatch(/repo/);
    expect(error?.text).toMatch(/prompt/);
    // It does not go on to say it mapped anything.
    expect(lines.some((line) => line.text.startsWith("trigger rules:"))).toBe(
      false,
    );
  });

  it("refuses text that is not JSON, naming the variable", async () => {
    const { exit, lines } = await boot({ TRIGGER_RULES: "[{label: factory" });
    expect(exit._tag).toBe("Failure");
    expect(lines.find((line) => line.level === "Error")?.text).toContain(
      "TRIGGER_RULES",
    );
  });

  it("refuses a rule that names neither a label nor a team", async () => {
    const { exit, lines } = await boot({
      TRIGGER_RULES: '[{"repo":"acme/widgets","prompt":"x"}]',
    });
    expect(exit._tag).toBe("Failure");
    expect(lines.find((line) => line.level === "Error")?.text).toContain(
      "label, a team, or both",
    );
  });

  it("lists the rules of a valid value, each with the repo it maps to", async () => {
    const { exit, lines } = await boot({
      ...ALL_ARMED,
      TRIGGER_RULES: JSON.stringify([
        { label: "factory", repo: "acme/widgets", prompt: "{{title}}" },
        { team: "ENG", repo: "acme/api", prompt: "{{title}}" },
        // A card rule (LOB-254) says so, so the operator can tell which labels file a card.
        { label: "intake", repo: "acme/api", prompt: "", mode: "card" },
      ]),
    });

    expect(exit._tag).toBe("Success");
    const rules = lines.find((line) => line.text.startsWith("trigger rules:"));
    expect(rules?.level).toBe("Info");
    expect(rules?.text).toContain(
      "trigger rules: 3 (factory→acme/widgets, team ENG→acme/api, intake→acme/api card)",
    );
    expect(lines.some((line) => line.level === "Error")).toBe(false);
  });

  it("reads an unset or blank value as no fallback rules, which is not an error", async () => {
    for (const env of [{}, { TRIGGER_RULES: "" }, { TRIGGER_RULES: "  \n" }]) {
      const { exit, lines } = await boot(env);
      expect(exit._tag).toBe("Success");
      expect(
        lines.find((line) => line.text.startsWith("trigger rules:"))?.text,
      ).toContain("trigger rules: 0");
      expect(lines.some((line) => line.level === "Error")).toBe(false);
    }
    expect(
      await Effect.runPromise(readTriggerRules({ TRIGGER_RULES: "[]" })),
    ).toEqual([]);
  });
});

describe("webhook routes at boot", () => {
  it("logs armed for every route whose secret is set, and the secret nowhere", async () => {
    const { lines } = await boot(ALL_ARMED);
    for (const route of [
      "/webhooks/linear",
      "/webhooks/generic",
      "/webhooks/sentry",
      "/webhooks/github",
    ]) {
      expect(lines.map((line) => line.text)).toContain(
        `webhook ${route}: armed`,
      );
    }
    expect(lines.some((line) => line.text.includes(CANARY))).toBe(false);
  });

  it("logs unarmed, naming the variable, for each route whose secret is unset or blank", async () => {
    const { lines } = await boot({
      LINEAR_WEBHOOK_SECRET: CANARY,
      // Blank is unarmed: the route answers 503 for an empty secret, as for a missing one.
      SENTRY_CLIENT_SECRET: "",
    });
    const texts = lines.map((line) => line.text);
    expect(texts).toContain("webhook /webhooks/linear: armed");
    expect(texts).toContain(
      "webhook /webhooks/generic: unarmed: TRIGGER_SECRET unset",
    );
    expect(texts).toContain(
      "webhook /webhooks/sentry: unarmed: SENTRY_CLIENT_SECRET unset",
    );
    expect(texts).toContain(
      "webhook /webhooks/github: unarmed: GITHUB_WEBHOOK_SECRET unset",
    );
    // An unarmed route is the one that answers every delivery 503: it stands out as a warning.
    expect(
      lines.find((line) => line.text.includes("/webhooks/generic"))?.level,
    ).toBe("Warn");
    expect(lines.some((line) => line.text.includes(CANARY))).toBe(false);
  });

  it("has a row for every webhook path this app mounts, so a new route cannot be armed or unarmed in silence", () => {
    const here = join(import.meta.dirname);
    const mounted = new Set(
      readdirSync(here)
        .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
        .flatMap((name) =>
          [
            ...readFileSync(join(here, name), "utf8").matchAll(
              /"(\/webhooks\/[a-z-]+)"/g,
            ),
          ].flatMap((match) => match[1] ?? []),
        ),
    );
    expect(mounted.size).toBeGreaterThanOrEqual(4);
    const byName = (a: string, b: string) => a.localeCompare(b);
    expect([...mounted].sort(byName)).toEqual(
      WEBHOOK_ROUTES.map(({ route }) => route).sort(byName),
    );
    expect(describeWebhookRoutes({})).toHaveLength(WEBHOOK_ROUTES.length);
  });

  it("reads every variable the table names from the live environment, by name", () => {
    const names = [
      TRIGGER_RULES_VARIABLE,
      ...WEBHOOK_ROUTES.map((row) => row.variable),
    ];
    const saved = new Map(names.map((name) => [name, process.env[name]]));
    try {
      for (const name of names) process.env[name] = `value-of-${name}`;
      const snapshot = bootEnvFromProcess();
      for (const name of names) {
        expect(snapshot[name]).toBe(`value-of-${name}`);
      }
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
