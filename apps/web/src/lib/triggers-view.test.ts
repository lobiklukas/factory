/**
 * The Triggers page's rules (T4). What the server answers is proven where it is computed (core's
 * `TriggerDeliveries.test.ts`, the RPC router's test); the browser drive proves the page. These are
 * the cases a drive does not reach cheaply: a poll that shifts a page boundary, a filter key this
 * build did not mint, and an empty answer that has to say what emptied it.
 */
import type { DeliveryRecord } from "@repo/domain/Trigger";
import { describe, expect, it } from "vitest";
import {
  deliveryTarget,
  emptyMessage,
  filterInput,
  filterKey,
  inputOfKey,
  mergeDeliveries,
  receivedLabel,
  statusLabel,
} from "./triggers-view";

const row = (
  deliveryId: string,
  over: Partial<DeliveryRecord> = {},
): DeliveryRecord => ({
  deliveryId,
  receivedAt: "2026-10-28T10:00:00.000Z",
  status: "skipped",
  ...over,
});

describe("filters", () => {
  it("sends no filter for `all`, and the server's own words otherwise", () => {
    expect(filterInput("all", "all")).toEqual({});
    expect(filterInput("skipped", "all")).toEqual({ status: "skipped" });
    expect(filterInput("skipped", "linear")).toEqual({
      status: "skipped",
      source: "linear",
    });
  });

  it("round-trips a filter through the key its atom family uses", () => {
    expect(inputOfKey(filterKey("processed", "sentry"))).toEqual({
      status: "processed",
      source: "sentry",
    });
    // A key this build did not mint asks for everything rather than for a status that is not one.
    expect(inputOfKey("bogus/fax")).toEqual({});
    expect(inputOfKey("")).toEqual({});
  });

  it("names `received` as what it is: in flight", () => {
    expect(statusLabel("received")).toBe("In flight");
    expect(statusLabel("all")).toBe("All");
  });
});

describe("mergeDeliveries", () => {
  it("shows a delivery once, at the head, when a poll moved it out of the older pages", () => {
    const head = [row("c"), row("b")];
    const older = [row("b"), row("a")];
    expect(mergeDeliveries(head, older).map((r) => r.deliveryId)).toEqual([
      "c",
      "b",
      "a",
    ]);
  });

  it("prefers the head's copy of a row the poll re-read", () => {
    const fresh = row("b", { status: "processed" });
    const merged = mergeDeliveries([fresh], [row("b")]);
    expect(merged).toEqual([fresh]);
  });
});

describe("deliveryTarget", () => {
  it("names the session, else the card, else nothing", () => {
    const sessionId =
      "ses_0123456789abcdefghjkmnpqrs" as DeliveryRecord["sessionId"];
    const taskId = "tsk_0123456789abcdefghjkmnpqrs" as DeliveryRecord["taskId"];
    expect(deliveryTarget(row("a", { sessionId }))).toEqual({
      kind: "session",
      id: sessionId,
    });
    expect(deliveryTarget(row("a", { taskId }))).toEqual({
      kind: "card",
      id: taskId,
    });
    expect(deliveryTarget(row("a"))).toEqual({ kind: "none" });
  });
});

describe("receivedLabel", () => {
  it("is UTC to the second, and shows an unparseable value as it came", () => {
    expect(receivedLabel("2026-10-28T10:00:01.234Z")).toBe(
      "2026-10-28 10:00:01 UTC",
    );
    expect(receivedLabel("yesterday")).toBe("yesterday");
  });
});

describe("emptyMessage", () => {
  it("says what emptied the list, and what is never recorded when nothing did", () => {
    expect(emptyMessage("skipped", "linear")).toBe(
      "No delivery from linear that ended skipped is recorded.",
    );
    expect(emptyMessage("all", "all")).toContain("never recorded here");
  });
});
