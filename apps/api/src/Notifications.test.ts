/**
 * The notifier's boot (S-notifications): which sinks the environment configures, the kinds it
 * wants, what the boot line says — never a webhook URL or a topic — and the settings it refuses.
 */
import { ConfigProvider, Effect, Exit } from "effect";
import { FetchHttpClient } from "effect/http";
import { describe, expect, it } from "vitest";
import { describeNotifyPlan, NotifyConfig, notifyPlan } from "./Notifications";

const DASHBOARD = "http://localhost:3550";
const WEBHOOK = "https://hooks.slack.test/services/T0/B0/secret-part";

const plan = (env: Record<string, string>) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      return yield* notifyPlan(yield* NotifyConfig, DASHBOARD);
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({ env }),
      ),
    ),
  );

const planOf = async (env: Record<string, string>) => {
  const exit = await plan(env);
  if (Exit.isFailure(exit)) throw new Error(String(exit));
  return exit.value;
};

describe("the notifier's configuration", () => {
  it("is off with no sink, and the boot line says how to turn it on", async () => {
    const resolved = await planOf({});
    expect(resolved.sinks).toEqual([]);
    expect(describeNotifyPlan(resolved)).toBe(
      "notifications: off (set NOTIFY_SLACK_WEBHOOK_URL or NOTIFY_NTFY_TOPIC to notify a person when a run needs them)",
    );
  });

  it("treats a blank webhook as unset", async () => {
    expect((await planOf({ NOTIFY_SLACK_WEBHOOK_URL: "  " })).sinks).toEqual(
      [],
    );
  });

  it("names both sinks, every kind and the dashboard, and no secret", async () => {
    const resolved = await planOf({
      NOTIFY_SLACK_WEBHOOK_URL: WEBHOOK,
      NOTIFY_NTFY_URL: "http://127.0.0.1:3551",
      NOTIFY_NTFY_TOPIC: "secret-topic",
      NOTIFY_NTFY_TOKEN: "tk_secret",
    });
    expect(resolved.sinks.map((sink) => sink.id.split(":")[0])).toEqual([
      "slack",
      "ntfy",
    ]);
    const line = describeNotifyPlan(resolved);
    expect(line).toBe(
      `notifications: question, approval, gate, failed to a Slack incoming webhook and ntfy at http://127.0.0.1:3551, every 5000ms, linking to ${DASHBOARD}`,
    );
    for (const secret of ["secret-part", "secret-topic", "tk_secret"]) {
      expect(line).not.toContain(secret);
      for (const sink of resolved.sinks) {
        expect(sink.id).not.toContain(secret);
      }
    }
  });

  it("reads the kinds, the link base and the interval it is given", async () => {
    const resolved = await planOf({
      NOTIFY_NTFY_TOPIC: "alerts",
      NOTIFY_TYPES: "approval,failed",
      NOTIFY_LINK_BASE: "https://factory.example",
      NOTIFY_POLL_MS: "250",
    });
    expect([...resolved.kinds]).toEqual(["approval", "failed"]);
    expect(resolved.linkBase).toBe("https://factory.example");
    expect(resolved.pollMs).toBe(250);
    // ntfy's public server when no other is named.
    expect(describeNotifyPlan(resolved)).toContain("ntfy at https://ntfy.sh");
  });

  it("refuses an unknown kind", async () => {
    const exit = await plan({
      NOTIFY_NTFY_TOPIC: "alerts",
      NOTIFY_TYPES: "question,review",
    });
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("InvalidNotifyConfig");
    expect(String(exit)).toContain('"review"');
  });

  it("refuses an ntfy server with no topic", async () => {
    const exit = await plan({ NOTIFY_NTFY_URL: "http://127.0.0.1:3551" });
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("NOTIFY_NTFY_TOPIC is not");
  });

  it("refuses an interval that is not a positive integer", async () => {
    const exit = await plan({
      NOTIFY_NTFY_TOPIC: "alerts",
      NOTIFY_POLL_MS: "0",
    });
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
