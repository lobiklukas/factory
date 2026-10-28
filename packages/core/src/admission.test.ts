/**
 * Admission control's refusal as each boundary carries it (LOB-70): pure, no database.
 *
 * The cap itself is counted by the session service (`SessionService.test.ts`'s "admission control");
 * these cases pin what its `at_capacity` becomes in the trigger seam and on a GitHub-shaped route, so
 * a "not now" is never reported as a broken session create or answered with a `500`.
 */
import { SessionError } from "@repo/domain/Session";
import { TriggerError } from "@repo/domain/Trigger";
import { describe, expect, it } from "vitest";
import {
  AT_CAPACITY_RETRY_AFTER_S,
  atCapacity,
  SESSION_MAX_CONCURRENT,
  triggerErrorOfSession,
  triggerFailureAnswer,
} from "./admission";

describe("the at_capacity refusal", () => {
  it("names the limit and where it is configured", () => {
    const refused = atCapacity({ limit: 3, source: SESSION_MAX_CONCURRENT });
    expect(refused.code).toBe("at_capacity");
    expect(refused.message).toContain("at most 3 sessions");
    expect(refused.message).toContain("SESSION_MAX_CONCURRENT=3");
    expect(atCapacity({ limit: 1, source: "X" }).message).toContain(
      "at most 1 session may",
    );
  });

  it("keeps its meaning in the trigger seam, and every other session failure stays session-create", () => {
    expect(
      triggerErrorOfSession(atCapacity({ limit: 2, source: "K" })).code,
    ).toBe("at-capacity");
    for (const code of ["not_found", "storage", "harness"] as const) {
      const mapped = triggerErrorOfSession(
        new SessionError({ code, message: `a ${code} failure` }),
      );
      expect(mapped.code).toBe("session-create");
      expect(mapped.message).toBe(`a ${code} failure`);
    }
  });

  it("is a 503 with Retry-After on a route, and any other trigger failure a 500 without one", () => {
    const busy = triggerFailureAnswer(
      new TriggerError({ code: "at-capacity", message: "full" }),
    );
    expect(busy.status).toBe(503);
    expect(busy.headers).toEqual({
      "retry-after": String(AT_CAPACITY_RETRY_AFTER_S),
    });
    expect(busy.body).toMatchObject({
      ok: false,
      code: "at-capacity",
      error: "full",
    });
    const broken = triggerFailureAnswer(
      new TriggerError({ code: "session-create", message: "broken" }),
    );
    expect(broken.status).toBe(500);
    expect(broken.headers).toBeUndefined();
    expect(broken.body).toMatchObject({ ok: false, code: "session-create" });
  });
});
