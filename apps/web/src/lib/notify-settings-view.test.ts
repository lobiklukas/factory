import { describe, expect, it } from "vitest";
import type {
  NotificationSettings,
  NotificationSinkSummary,
} from "@repo/domain/Notify";
import {
  applicationServerKey,
  emailDestination,
  kindRows,
  kindSource,
  notifyRefusal,
  PUSH_SUPPORT_COPY,
  pushDestination,
  pushSupport,
  sinkTitle,
} from "./notify-settings-view";

const settings = (
  kinds: NotificationSettings["kinds"],
): NotificationSettings => ({
  actor: "dashboard",
  kinds,
  sinks: [],
  channels: { email: true, webPush: { configured: false }, shared: [] },
});

describe("kindRows", () => {
  it("names each kind and keeps its toggle and where the toggle came from", () => {
    const rows = kindRows(
      settings([
        { kind: "question", enabled: true, stored: false },
        { kind: "approval", enabled: false, stored: true },
      ]),
    );
    expect(rows.map((row) => [row.kind, row.label, row.enabled])).toEqual([
      ["question", "Questions", true],
      ["approval", "Approvals", false],
    ]);
    expect(kindSource({ stored: true })).toBe("set here");
    expect(kindSource({ stored: false })).toBe("from NOTIFY_TYPES");
  });
});

describe("sinkTitle", () => {
  const sink = (
    type: NotificationSinkSummary["type"],
    label: string,
  ): NotificationSinkSummary => ({
    id: "nsk_1",
    type,
    label,
    enabled: true,
    createdAt: "2026-10-29T00:00:00.000Z",
  });
  it("leads with the type and then where it goes", () => {
    expect(sinkTitle(sink("email", "amy@example.test"))).toBe(
      "Email · amy@example.test",
    );
    expect(sinkTitle(sink("web_push", "push.example.test"))).toBe(
      "Web Push · push.example.test",
    );
  });
});

describe("emailDestination", () => {
  it("trims a good address and sends it as typed", () => {
    expect(emailDestination("  amy@example.test ")).toEqual({
      ok: true,
      destination: { type: "email", address: "amy@example.test" },
    });
  });
  it("stops a typo before anything is sent", () => {
    for (const bad of [
      "",
      "amy",
      "amy@example",
      "a b@example.test",
      "@x.test",
    ]) {
      expect(emailDestination(bad), bad).toMatchObject({ ok: false });
    }
  });
});

describe("pushDestination", () => {
  it("is the subscription's endpoint and its two keys", () => {
    expect(
      pushDestination({
        endpoint: "https://push.example.test/x",
        keys: { p256dh: "P", auth: "A" },
      }),
    ).toEqual({
      ok: true,
      destination: {
        type: "web_push",
        endpoint: "https://push.example.test/x",
        p256dh: "P",
        auth: "A",
      },
    });
  });
  it("is refused when the browser left out any of them", () => {
    expect(pushDestination({})).toMatchObject({ ok: false });
    expect(
      pushDestination({ endpoint: "https://x.test/", keys: { p256dh: "P" } }),
    ).toMatchObject({ ok: false });
  });
});

describe("applicationServerKey", () => {
  it("reads base64url, with or without padding, as bytes", () => {
    // 65 bytes 0x04 followed by 0..63, as a P-256 public key is laid out.
    const bytes = Uint8Array.from([
      4,
      ...Array.from({ length: 64 }, (_, n) => n),
    ]);
    const url = Buffer.from(bytes).toString("base64url");
    expect([...applicationServerKey(url)]).toEqual([...bytes]);
    expect([...applicationServerKey(`${url}==`)]).toEqual([...bytes]);
    expect(applicationServerKey(url)).toHaveLength(65);
  });
});

describe("pushSupport", () => {
  const full = { serviceWorker: true, pushManager: true, secureContext: true };
  it("needs a secure context, a service worker and a push manager, in that order of blame", () => {
    expect(pushSupport(full)).toBe("supported");
    expect(pushSupport({ ...full, secureContext: false })).toBe(
      "insecure_context",
    );
    expect(pushSupport({ ...full, serviceWorker: false })).toBe(
      "no_service_worker",
    );
    expect(pushSupport({ ...full, pushManager: false })).toBe("no_push");
    expect(PUSH_SUPPORT_COPY.insecure_context).toContain("https");
  });
});

describe("notifyRefusal", () => {
  it("shows the server's words for a typed refusal, else the cause", () => {
    expect(
      notifyRefusal(
        {
          _tag: "InvalidNotificationSink",
          message: "bad address; nothing was stored",
        },
        "cause text",
      ),
    ).toBe("bad address; nothing was stored");
    expect(notifyRefusal(undefined, "cause text")).toBe("cause text");
    expect(notifyRefusal({ _tag: "X", message: "" }, "cause text")).toBe(
      "cause text",
    );
  });
});
