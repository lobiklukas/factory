/**
 * The notifier's boot (S-notifications): which sinks the environment configures, the kinds it
 * wants, what the boot line says — never a webhook URL or a topic — and the settings it refuses.
 */
import { ConfigProvider, Effect, Exit } from "effect";
import { FetchHttpClient } from "effect/http";
import { describe, expect, it } from "vitest";
import { generateVapidKeys } from "@repo/core";
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
      `notifications: question, approval, gate, failed, spend to a Slack incoming webhook and ntfy at http://127.0.0.1:3551, every 5000ms, linking to ${DASHBOARD}`,
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

describe("personal sinks and retention (F21, F22)", () => {
  const keys = generateVapidKeys();
  const smtp = {
    NOTIFY_SMTP_URL: "smtp://factory:smtp-secret@mail.example.test:2525",
    NOTIFY_SMTP_FROM: "factory@example.test",
  };
  const vapid = {
    NOTIFY_VAPID_PUBLIC_KEY: keys.publicKey,
    NOTIFY_VAPID_PRIVATE_KEY: keys.privateKey,
  };

  it("keeps thirty days of history unless told otherwise, and reads the days it is given", async () => {
    expect((await planOf({})).retentionMs).toBe(30 * 24 * 60 * 60 * 1000);
    expect((await planOf({ NOTIFY_RETENTION_DAYS: "7" })).retentionMs).toBe(
      7 * 24 * 60 * 60 * 1000,
    );
    for (const bad of ["0", "-3", "1.5", "soon"]) {
      expect(
        Exit.isFailure(await plan({ NOTIFY_RETENTION_DAYS: bad })),
        bad,
      ).toBe(true);
    }
  });

  it("offers email and Web Push to each person when they are configured, and the boot line says so without a secret", async () => {
    const resolved = await planOf({
      ...smtp,
      ...vapid,
      NOTIFY_VAPID_SUBJECT: "mailto:ops@example.test",
    });
    expect(resolved.sinks).toEqual([]);
    expect(resolved.channels.email?.from).toBe("factory@example.test");
    expect(resolved.channels.vapid?.publicKey).toBe(keys.publicKey);
    expect(resolved.channels.allowInsecurePush).toBe(false);
    const line = describeNotifyPlan(resolved);
    expect(line).toBe(
      `notifications: question, approval, gate, failed to each person's email and each person's Web Push, every 5000ms, linking to ${DASHBOARD}`,
    );
    for (const secret of ["smtp-secret", keys.privateKey]) {
      expect(line).not.toContain(secret);
    }
  });

  it("puts the shared sinks first when both kinds are configured", async () => {
    const line = describeNotifyPlan(
      await planOf({ ...smtp, NOTIFY_NTFY_TOPIC: "alerts" }),
    );
    expect(line).toContain(
      "to ntfy at https://ntfy.sh and each person's email,",
    );
  });

  it("defaults the push contact to the mail sender, and wants one otherwise", async () => {
    const fromSender = await planOf({ ...smtp, ...vapid });
    expect(fromSender.channels.vapid?.subject).toBe(
      "mailto:factory@example.test",
    );
    const exit = await plan(vapid);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("NOTIFY_VAPID_SUBJECT");
  });

  it("refuses an SMTP server with no sender, a sender with no server, and an SMTP URL that is not one, never repeating the password", async () => {
    const noFrom = await plan({ NOTIFY_SMTP_URL: smtp.NOTIFY_SMTP_URL });
    expect(String(noFrom)).toContain("NOTIFY_SMTP_FROM");
    expect(String(noFrom)).not.toContain("smtp-secret");
    expect(
      String(await plan({ NOTIFY_SMTP_FROM: "factory@example.test" })),
    ).toContain("NOTIFY_SMTP_URL is not");
    const bad = await plan({
      NOTIFY_SMTP_URL: "https://factory:smtp-secret@mail.example.test",
      NOTIFY_SMTP_FROM: "factory@example.test",
    });
    expect(Exit.isFailure(bad)).toBe(true);
    expect(String(bad)).toContain("smtp:// or smtps://");
    expect(String(bad)).not.toContain("smtp-secret");
    expect(
      Exit.isFailure(
        await plan({ ...smtp, NOTIFY_SMTP_FROM: "not an address" }),
      ),
    ).toBe(true);
  });

  it("refuses half a VAPID key pair and a pair that is not one, never repeating the private key", async () => {
    expect(
      String(await plan({ NOTIFY_VAPID_PUBLIC_KEY: keys.publicKey })),
    ).toContain("together or not at all");
    const other = generateVapidKeys();
    const mismatched = await plan({
      ...smtp,
      NOTIFY_VAPID_PUBLIC_KEY: keys.publicKey,
      NOTIFY_VAPID_PRIVATE_KEY: other.privateKey,
    });
    expect(String(mismatched)).toContain("public half");
    expect(String(mismatched)).not.toContain(other.privateKey);
  });
});
