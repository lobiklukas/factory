/**
 * `factory pr`'s answer (LOB-86): a link is printed only when the step answered one, and an answer
 * that opened nothing is a refusal a script can branch on.
 *
 * The command itself is proven by `.pi/skills/verify-board/drive.sh`'s build phase, which runs it in a
 * terminal against a control plane pointed at the loopback GitHub fake and reads the link back from
 * the fake's ledger — and, with no GitHub path, sees it fail with the server's reason. These cases are
 * the ones a pane capture would not localize: which outcomes count as a PR at all.
 */
import { describe, expect, it } from "vitest";
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
});
