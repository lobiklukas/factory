/**
 * `factory triggers ls`'s rendering (T4).
 *
 * The command is proven in a terminal by `.pi/skills/verify-cli/triggers.sh`; these are the cases a
 * pane capture would not localize: which column each field lands in, that a skip's reason survives
 * unchanged, and that an empty answer names the filter that emptied it.
 */
import type { DeliveryRecord } from "@repo/domain/Trigger";
import { describe, expect, it } from "vitest";
import { DELIVERY_HEADER, deliveryLines, deliveryRow, NONE } from "./triggers";

const processed: DeliveryRecord = {
  deliveryId: "lin-1",
  source: "linear",
  receivedAt: "2026-10-28T10:00:00.000Z",
  status: "processed",
  reason: 'rule "factory" mapped it to acme/widgets',
  sessionId: "ses_0123456789abcdefghjkmnpqrs" as DeliveryRecord["sessionId"],
};

const skipped: DeliveryRecord = {
  deliveryId: "lin-2",
  receivedAt: "2026-10-28T09:00:00.000Z",
  status: "skipped",
  reason: "repo acme/nope is not registered",
};

const field = (row: string, name: string): string | undefined =>
  row.split("\t")[DELIVERY_HEADER.split("\t").indexOf(name)];

describe("deliveryRow", () => {
  it("puts each fact in its own column, the reason last and unchanged", () => {
    const row = deliveryRow(processed);
    expect(field(row, "received-at")).toBe("2026-10-28T10:00:00.000Z");
    expect(field(row, "source")).toBe("linear");
    expect(field(row, "status")).toBe("processed");
    expect(field(row, "delivery")).toBe("lin-1");
    expect(field(row, "session")).toBe("ses_0123456789abcdefghjkmnpqrs");
    expect(field(row, "card")).toBe(NONE);
    expect(field(row, "reason")).toBe(
      'rule "factory" mapped it to acme/widgets',
    );
    expect(row.split("\t")).toHaveLength(DELIVERY_HEADER.split("\t").length);
  });

  it("prints none for what a delivery has no value for, never an empty cell", () => {
    const row = deliveryRow({ ...skipped, reason: undefined });
    expect(field(row, "source")).toBe(NONE);
    expect(field(row, "session")).toBe(NONE);
    expect(field(row, "card")).toBe(NONE);
    expect(field(row, "reason")).toBe(NONE);
    expect(row.split("\t").every((cell) => cell !== "")).toBe(true);
  });

  it("keeps a reason with a newline or tab on one row", () => {
    const row = deliveryRow({ ...skipped, reason: "setup failed:\nno\tnet" });
    expect(row.includes("\n")).toBe(false);
    expect(row.split("\t")).toHaveLength(DELIVERY_HEADER.split("\t").length);
    expect(field(row, "reason")).toBe("setup failed: no net");
  });
});

describe("deliveryLines", () => {
  it("is the header and a row per delivery, in the order the server answered", () => {
    expect(deliveryLines([processed, skipped])).toEqual([
      DELIVERY_HEADER,
      deliveryRow(processed),
      deliveryRow(skipped),
    ]);
  });

  it("says what emptied an empty answer", () => {
    expect(deliveryLines([])).toEqual(["no deliveries"]);
    expect(deliveryLines([], { status: "skipped" })).toEqual([
      "no deliveries with status skipped",
    ]);
    expect(
      deliveryLines([], { source: "sentry", status: "processed" }),
    ).toEqual(["no deliveries with source sentry and status processed"]);
  });
});
