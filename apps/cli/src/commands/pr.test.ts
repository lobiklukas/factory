/**
 * `factory pr`'s answer (LOB-86): a link is printed only when the step answered one, and an answer
 * that opened nothing is a refusal a script can branch on.
 *
 * The command itself is proven by `.pi/skills/verify-board/drive.sh`'s build phase, which runs it in a
 * terminal against a control plane pointed at the loopback GitHub fake and reads the link back from
 * the fake's ledger — and, with no GitHub path, sees it fail with the server's reason. These cases are
 * the ones a pane capture would not localize: which outcomes count as a PR at all, and how the typed
 * failures the server answers are printed.
 */
import { CredentialError, PrError } from "@repo/domain/PullRequest";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reportFailures } from "../errors";
import { prAnswer } from "./pr";

const SESSION = "ses_01m5yvfya2tsyn56ycr5jj3pvs";
const URL = "https://github.com/lobiklukas/factory/pull/7";

describe("prAnswer", () => {
  it("prints the link, its number and which path answered, for a PR that exists", () => {
    expect(
      prAnswer(SESSION, { outcome: "opened", number: 7, url: URL }),
    ).toEqual({
      _tag: "Opened",
      lines: [`pr       ${URL}`, "number   7", "outcome  opened"],
    });
    expect(
      prAnswer(SESSION, { outcome: "already-open", number: 7, url: URL }),
    ).toEqual({
      _tag: "Opened",
      lines: [`pr       ${URL}`, "number   7", "outcome  already-open"],
    });
  });

  it("refuses an unchanged branch as no_change, with no link", () => {
    const answer = prAnswer(SESSION, { outcome: "no-change" });
    expect(answer).toEqual({
      _tag: "NotOpened",
      code: "no_change",
      message: `session ${SESSION}'s branch has no change against its base; no PR was opened`,
    });
    expect(JSON.stringify(answer)).not.toContain("https://");
  });

  it("refuses a branch the forge would not take as non_fast_forward, naming it, with no link", () => {
    const answer = prAnswer(SESSION, {
      outcome: "non-fast-forward",
      head: `factory/${SESSION}`,
    });
    expect(answer).toMatchObject({
      _tag: "NotOpened",
      code: "non_fast_forward",
    });
    if (answer._tag !== "NotOpened") return;
    expect(answer.message).toContain(`factory/${SESSION}`);
    expect(answer.message).toContain("No PR was opened");
    expect(JSON.stringify(answer)).not.toContain("https://");
  });

  it("refuses an over-cap diff as over_cap, naming the limit and the numbers", () => {
    expect(
      prAnswer(SESSION, {
        outcome: "over-cap",
        limit: "files",
        cap: 50,
        measured: 73,
      }),
    ).toEqual({
      _tag: "NotOpened",
      code: "over_cap",
      message: `session ${SESSION}'s diff is over the cap (73 files, at most 50); no PR was opened`,
    });
  });

  // F14: a refused update of a PR that is open says the PR was left, not that none was opened.
  it("names the PR a refused update left as it was, rather than saying none was opened", () => {
    const pr = "https://github.com/acme/web/pull/7";
    const overCap = prAnswer(SESSION, {
      outcome: "over-cap",
      limit: "files",
      cap: 50,
      measured: 73,
      pullRequest: pr,
    });
    const behind = prAnswer(SESSION, {
      outcome: "non-fast-forward",
      head: `factory/${SESSION}`,
      pullRequest: pr,
    });
    for (const answer of [overCap, behind]) {
      expect(answer._tag).toBe("NotOpened");
      if (answer._tag !== "NotOpened") continue;
      expect(answer.message).toContain(`othing was pushed to ${pr}`);
      expect(answer.message).not.toMatch(/no PR was opened/i);
    }
  });
});

describe("factory pr's typed failures", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** What `reportFailures` — the handler `prCommand` runs its program under — prints and exits. */
  const reported = async (error: CredentialError | PrError) => {
    const printed: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      printed.push(String(line));
    });
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    await Effect.runPromise(reportFailures(Effect.fail(error)));
    return { printed, exitCodes: exit.mock.calls.map(([code]) => code) };
  };

  it("prints a missing credential as credential_error with the server's words, and exits 1", async () => {
    const message =
      "no GITHUB_TOKEN configured; cannot resolve a token for verify-board/fixture";
    expect(
      await reported(
        new CredentialError({
          repo: "verify-board/fixture",
          code: "missing",
          message,
        }),
      ),
    ).toEqual({
      printed: [`error: credential_error: ${message}`],
      exitCodes: [1],
    });
  });

  it("prints a forge failure as pr_error, and exits 1", async () => {
    expect(
      await reported(
        new PrError({
          operation: "create",
          ref: "factory/ses_x",
          message: "GitHub answered 422",
        }),
      ),
    ).toEqual({
      printed: ["error: pr_error: GitHub answered 422"],
      exitCodes: [1],
    });
  });
});
