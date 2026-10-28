/**
 * The "Open pull request" control's decisions (C7). The click itself, and the link appearing in both
 * panes without a reload, are proven in a browser by `.pi/skills/verify-web` (`pr.sh`) and
 * `.pi/skills/verify-board`; these are the cases a screenshot cannot settle: which answers are a
 * refusal, which refusals stick, and when the control is offered at all.
 */
import { CredentialError, PrError } from "@repo/domain/PullRequest";
import { SessionError } from "@repo/domain/Session";
import { Cause } from "effect";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vitest";
import {
  attemptOfCause,
  attemptOfResult,
  attemptOfStep,
  openedUrl,
  prOffer,
  prTitleFor,
  staleRefusal,
  type PrAttempt,
} from "./pr-open-view";

const URL = "https://github.com/acme/web/pull/7";
const idle = { repo: "acme/web", status: "idle", prUrl: undefined } as const;

describe("attemptOfStep", () => {
  it("is a link for an opened PR and for the one the log already held", () => {
    expect(attemptOfStep({ outcome: "opened", number: 7, url: URL })).toEqual({
      _tag: "opened",
      url: URL,
    });
    expect(
      attemptOfStep({ outcome: "already-open", number: 7, url: URL }),
    ).toEqual({ _tag: "opened", url: URL });
  });

  it("refuses an empty branch in the words the write-back uses", () => {
    expect(attemptOfStep({ outcome: "no-change" })).toEqual({
      _tag: "refused",
      reason:
        "the run changed no file against its base branch, so there is nothing to open a pull request for",
    });
  });

  it("refuses a diff over the cap, naming the limit, the cap and what the branch measured", () => {
    expect(
      attemptOfStep({
        outcome: "over-cap",
        limit: "lines",
        cap: 2000,
        measured: 4100,
      }),
    ).toEqual({
      _tag: "refused",
      reason:
        "the branch changes 4100 lines, over the cap of 2000, so no pull request was opened",
    });
  });
});

describe("attemptOfCause", () => {
  it("keeps a missing credential's message verbatim, and it is a refusal", () => {
    const message =
      "no GITHUB_TOKEN configured; cannot resolve a token for acme/web";
    expect(
      attemptOfCause(
        Cause.fail(
          new CredentialError({ repo: "acme/web", code: "missing", message }),
        ),
      ),
    ).toEqual({ _tag: "refused", reason: message });
  });

  it("keeps the session's own refusal verbatim, and it is a refusal", () => {
    const message =
      "session ses_x is bound to no repo, so it has no PR to open";
    expect(
      attemptOfCause(
        Cause.fail(new SessionError({ code: "invalid_input", message })),
      ),
    ).toEqual({ _tag: "refused", reason: message });
  });

  it("keeps the forge's failure verbatim, but it may succeed next time", () => {
    const message = "GitHub answered 502 creating the pull request";
    expect(
      attemptOfCause(
        Cause.fail(new PrError({ operation: "create", ref: "x", message })),
      ),
    ).toEqual({ _tag: "failed", reason: message });
  });

  it("falls back to the cause's text for a failure that is not typed", () => {
    const attempt = attemptOfCause(Cause.die(new Error("connection dropped")));
    expect(attempt._tag).toBe("failed");
    expect(attempt._tag === "failed" && attempt.reason).toContain(
      "connection dropped",
    );
  });
});

describe("attemptOfResult", () => {
  it("is nothing before a press, opening while the call is in flight, and the answer after", () => {
    expect(attemptOfResult(AsyncResult.initial())).toEqual({ _tag: "none" });
    expect(attemptOfResult(AsyncResult.initial(true))).toEqual({
      _tag: "opening",
    });
    expect(
      attemptOfResult(
        AsyncResult.success({ outcome: "opened", number: 7, url: URL }),
      ),
    ).toEqual({ _tag: "opened", url: URL });
    expect(
      attemptOfResult(
        AsyncResult.failure(
          Cause.fail(
            new CredentialError({
              repo: "acme/web",
              code: "missing",
              message: "no token",
            }),
          ),
        ),
      ),
    ).toEqual({ _tag: "refused", reason: "no token" });
  });
});

describe("prOffer", () => {
  const none: PrAttempt = { _tag: "none" };

  it("offers the button to a repo-bound, idle session with no PR", () => {
    expect(prOffer(idle, none)).toEqual({ _tag: "available" });
  });

  it("offers nothing to a scratch session: it has no branch to publish", () => {
    expect(prOffer({ ...idle, repo: undefined }, none)).toEqual({
      _tag: "hidden",
    });
  });

  it("offers nothing while the run is busy: the branch is still changing", () => {
    expect(prOffer({ ...idle, status: "busy" }, none)).toEqual({
      _tag: "hidden",
    });
  });

  it("offers nothing once the session records a PR, or the press just made one", () => {
    expect(prOffer({ ...idle, prUrl: URL }, none)).toEqual({ _tag: "hidden" });
    expect(prOffer(idle, { _tag: "opened", url: URL })).toEqual({
      _tag: "hidden",
    });
  });

  it("is opening while the call is in flight, even when the run is busy", () => {
    expect(prOffer(idle, { _tag: "opening" })).toEqual({ _tag: "opening" });
    expect(prOffer({ ...idle, status: "busy" }, { _tag: "opening" })).toEqual({
      _tag: "opening",
    });
  });

  it("keeps a refusal disabled with the server's reason, for as long as the session is idle", () => {
    expect(prOffer(idle, { _tag: "refused", reason: "over the cap" })).toEqual({
      _tag: "blocked",
      reason: "over the cap",
    });
  });

  it("keeps a retryable failure pressable, and carries what it said", () => {
    expect(prOffer(idle, { _tag: "failed", reason: "502" })).toEqual({
      _tag: "available",
      retry: "502",
    });
  });
});

describe("staleRefusal", () => {
  it("drops a verdict once a run has started on the branch it judged", () => {
    expect(staleRefusal({ _tag: "refused", reason: "x" }, "busy")).toBe(true);
    expect(staleRefusal({ _tag: "failed", reason: "x" }, "busy")).toBe(true);
  });

  it("keeps it while the session is idle, and ignores attempts that are not verdicts", () => {
    expect(staleRefusal({ _tag: "refused", reason: "x" }, "idle")).toBe(false);
    expect(staleRefusal({ _tag: "opening" }, "busy")).toBe(false);
    expect(staleRefusal({ _tag: "opened", url: URL }, "busy")).toBe(false);
    expect(staleRefusal({ _tag: "refused", reason: "x" }, undefined)).toBe(
      false,
    );
  });
});

describe("openedUrl, prTitleFor", () => {
  it("reads a link only off an opened attempt", () => {
    expect(openedUrl({ _tag: "opened", url: URL })).toBe(URL);
    expect(openedUrl({ _tag: "refused", reason: "x" })).toBeUndefined();
  });

  it("titles the PR after the session, and after its id when it has no title", () => {
    expect(prTitleFor("Fix the cap", "ses_1")).toBe("Fix the cap");
    expect(prTitleFor("  ", "ses_1")).toBe("ses_1");
    expect(prTitleFor(undefined, "ses_1")).toBe("ses_1");
  });
});
