/**
 * Which settled runs open their PR with no operator (C18), and the sentence a run that opened none
 * leaves. The integration — a real run settling, the fake forge, the card's thread — is
 * `SessionService.prOnSettle.test.ts`; this pins every branch of the rule, including the ones a run
 * there never reaches (a fork, a released workspace, a PR already recorded).
 */
import { describe, expect, it } from "vitest";
import {
  notOpenedText,
  opensPullRequestOnSettle,
  settleDeclarationOf,
  TRIGGER_PREFIX,
  type SettledRun,
} from "./prOnSettle";
import { sessionRequestIdOf, triggerActorOf } from "./TriggerService";

const trigger: SettledRun = {
  repo: "acme/widgets",
  requestId: "trigger:delivery-1",
  prUrl: null,
  actor: "trigger:linear",
  forkedFrom: null,
  released: false,
  waiting: false,
  columnRequires: undefined,
};

describe("opensPullRequestOnSettle", () => {
  it("opens for a session a trigger opened, whatever its source", () => {
    expect(opensPullRequestOnSettle(trigger)).toBe(true);
    expect(
      opensPullRequestOnSettle({ ...trigger, actor: "trigger:sentry" }),
    ).toBe(true);
  });

  it("spells the trigger prefix as the trigger seam writes it", () => {
    expect(sessionRequestIdOf("d-1").startsWith(TRIGGER_PREFIX)).toBe(true);
    expect(triggerActorOf("linear").startsWith(TRIGGER_PREFIX)).toBe(true);
  });

  it("reads a trigger's session from its delivery: a replay keeps the actor and has none", () => {
    // A replay of a trigger's session: its source's actor, no request id, no fork lineage.
    expect(opensPullRequestOnSettle({ ...trigger, requestId: null })).toBe(
      false,
    );
    // A client's own request id is not a delivery.
    expect(
      opensPullRequestOnSettle({ ...trigger, requestId: "cli-retry-1" }),
    ).toBe(false);
  });

  it("leaves a person's session, and one attributed to nobody, to the person", () => {
    expect(
      opensPullRequestOnSettle({ ...trigger, actor: "person:lukas" }),
    ).toBe(false);
    expect(opensPullRequestOnSettle({ ...trigger, actor: null })).toBe(false);
  });

  it("decides a card's run by its column alone: a column that requires a PR opens one", () => {
    expect(
      opensPullRequestOnSettle({
        ...trigger,
        actor: "person:lukas",
        columnRequires: ["non_empty_diff", "pr_link"],
      }),
    ).toBe(true);
    // A run a trigger started on a card in a column that needs no PR (the reviewer) opens none.
    expect(
      opensPullRequestOnSettle({
        ...trigger,
        columnRequires: ["verified", "review_verdict"],
      }),
    ).toBe(false);
    // A column the pinned version no longer declares requires nothing.
    expect(opensPullRequestOnSettle({ ...trigger, columnRequires: [] })).toBe(
      false,
    );
  });

  // C19 review: a fix run started in `review` works on the card's branch, so its commits are owed
  // to the card's PR although its column requires none.
  it("takes the step for a card's run of any column that continues a branch with the card's PR (C19)", () => {
    const review = {
      ...trigger,
      actor: "person:lukas",
      columnRequires: ["verified", "review_verdict"],
    };
    expect(opensPullRequestOnSettle({ ...review, continuesCardPr: true })).toBe(
      true,
    );
    expect(
      opensPullRequestOnSettle({ ...review, continuesCardPr: false }),
    ).toBe(false);
    // Still not once it recorded the PR itself, nor when it ended parked on a person.
    expect(
      settleDeclarationOf({
        ...review,
        continuesCardPr: true,
        prUrl: "https://github.com/acme/widget/pull/1",
      }),
    ).toBe("undeclared");
    expect(
      settleDeclarationOf({ ...review, continuesCardPr: true, waiting: true }),
    ).toBe("parked");
  });

  it("has nothing to open with no repo, a PR already recorded, or a released workspace", () => {
    expect(opensPullRequestOnSettle({ ...trigger, repo: null })).toBe(false);
    expect(
      opensPullRequestOnSettle({
        ...trigger,
        prUrl: "https://github.com/acme/widgets/pull/1",
      }),
    ).toBe(false);
    expect(opensPullRequestOnSettle({ ...trigger, released: true })).toBe(
      false,
    );
  });

  it("opens nothing for a run that ended parked on a person", () => {
    expect(opensPullRequestOnSettle({ ...trigger, waiting: true })).toBe(false);
    expect(
      opensPullRequestOnSettle({
        ...trigger,
        waiting: true,
        columnRequires: ["pr_link"],
      }),
    ).toBe(false);
  });

  it("tells a declared run that ended parked from a session that declares none", () => {
    expect(settleDeclarationOf(trigger)).toBe("declared");
    expect(settleDeclarationOf({ ...trigger, waiting: true })).toBe("parked");
    expect(
      settleDeclarationOf({
        ...trigger,
        actor: "person:lukas",
        waiting: true,
        columnRequires: ["pr_link"],
      }),
    ).toBe("parked");
    // Waiting says nothing about a session that never declared a PR, or has none left to open.
    expect(
      settleDeclarationOf({ ...trigger, actor: "person:lukas", waiting: true }),
    ).toBe("undeclared");
    expect(
      settleDeclarationOf({
        ...trigger,
        waiting: true,
        columnRequires: ["verified", "review_verdict"],
      }),
    ).toBe("undeclared");
    expect(
      settleDeclarationOf({ ...trigger, waiting: true, released: true }),
    ).toBe("undeclared");
  });

  it("leaves a fork's or a replay's PR to whoever forked it", () => {
    expect(
      opensPullRequestOnSettle({
        ...trigger,
        forkedFrom: "ses_01jz0000000000000000000000",
      }),
    ).toBe(false);
    expect(
      opensPullRequestOnSettle({
        ...trigger,
        forkedFrom: "ses_01jz0000000000000000000000",
        columnRequires: ["pr_link"],
      }),
    ).toBe(false);
  });
});

describe("notOpenedText", () => {
  const head = "the run settled and the PR step opened no PR";

  it("names the step's own numbers and refs", () => {
    expect(notOpenedText({ outcome: "no-change" })).toBe(
      `${head}: the branch has no change against its base`,
    );
    expect(
      notOpenedText({
        outcome: "over-cap",
        limit: "lines",
        cap: 2_000,
        measured: 2_401,
      }),
    ).toBe(
      `${head}: the branch's diff is over the cap (2401 lines, at most 2000)`,
    );
    expect(
      notOpenedText({ outcome: "non-fast-forward", head: "factory/ses_x" }),
    ).toBe(
      `${head}: the remote's factory/ses_x has commits this branch does not, and the push is never forced; integrate them, then open the PR`,
    );
  });

  it("says a stopped run opened nothing over its branch, and how its PR still opens", () => {
    const tail = "a run that finishes opens it, or `factory pr` does";
    expect(notOpenedText({ outcome: "stopped", ending: "interrupted" })).toBe(
      `the run settled without finishing, so no PR was opened over its branch: it was interrupted; ${tail}`,
    );
    expect(notOpenedText({ outcome: "stopped", ending: "budget" })).toContain(
      "its budget stopped it",
    );
    expect(notOpenedText({ outcome: "stopped", ending: "failed" })).toContain(
      "its model answer failed",
    );
  });

  it("names a failure by its tag and its own message", () => {
    expect(
      notOpenedText({
        outcome: "failed",
        tag: "CredentialError",
        message: "no GITHUB_TOKEN configured; cannot resolve a token for a/b",
      }),
    ).toBe(
      `${head}: CredentialError: no GITHUB_TOKEN configured; cannot resolve a token for a/b`,
    );
  });
});
