/** The skill pages' wording and form rules (D8). */
import { describe, expect, it } from "vitest";
import type { SkillRecord, SkillVersionSummary } from "@repo/domain/Skill";
import { DASHBOARD_ACTOR } from "./approvals-view";
import {
  authorLabel,
  createdMessage,
  formChanged,
  historyRows,
  movedRefusal,
  nextVersion,
  olderVersionNotice,
  oneLine,
  publishInput,
  skillForm,
  skillRefusal,
  versionSearch,
} from "./skills-view";

const specify: SkillRecord = {
  name: "specify",
  version: 3,
  newest: 3,
  description: "Turn a card into a spec",
  body: "# Specify\n\nAsk first.\n",
  attachments: ["docs/board.md"],
  createdAt: "2026-10-28T10:00:00.000Z",
  author: "dashboard",
};

describe("the Edit form", () => {
  it("opens on the newest version's description and body, as stored", () => {
    expect(skillForm(specify)).toEqual({
      description: specify.description,
      body: specify.body,
    });
  });

  /** Mutation: compare only the body, so a description-only edit could not be published. */
  it("is changed when either field differs from the newest version, and not otherwise", () => {
    const form = skillForm(specify);
    expect(formChanged(form, specify)).toBe(false);
    expect(formChanged({ ...form, body: `${form.body}More.\n` }, specify)).toBe(
      true,
    );
    expect(formChanged({ ...form, description: "Other" }, specify)).toBe(true);
  });

  /**
   * Mutations: drop the attachments (an edit would lose them), trim the body (the server's blank-body
   * refusal would never be reached), or send another actor.
   */
  it("publishes the form under the skill's name, keeping the newest's attachments, as the dashboard", () => {
    expect(publishInput(specify, { description: "New", body: "  \n" })).toEqual(
      {
        name: "specify",
        description: "New",
        body: "  \n",
        attachments: ["docs/board.md"],
        actor: DASHBOARD_ACTOR,
      },
    );
  });

  it("names the version a publish writes, and the one it created, from the server's numbers", () => {
    expect(nextVersion({ newest: 3 })).toBe(4);
    expect(createdMessage({ version: 4 })).toBe("v4 created");
  });

  /** Mutation: fall back to the cause for a typed refusal, losing the server's words. */
  it("shows a typed refusal in the server's words, and the cause for anything else", () => {
    expect(
      skillRefusal(
        {
          _tag: "InvalidSkill",
          message:
            'skill "specify" has an empty body: a run would be told nothing',
        },
        "cause",
      ),
    ).toEqual({
      tag: "InvalidSkill",
      message: 'skill "specify" has an empty body: a run would be told nothing',
    });
    expect(skillRefusal(undefined, "a dropped connection")).toEqual({
      tag: "Unknown",
      message: "a dropped connection",
    });
  });
});

describe("a publish after the newest moved", () => {
  /** Mutation: always answer null, so a stale form silently supersedes a newer version. */
  it("refuses when a version landed after the form opened, naming both and the one a retry writes", () => {
    const refusal = movedRefusal({ newest: 3 }, { newest: 4 });
    expect(refusal?.tag).toBe("NewestMoved");
    expect(refusal?.message).toContain(
      "v4 was published after this form opened on v3",
    );
    expect(refusal?.message).toContain("Publish again to write v5");
  });

  it("says nothing when the newest is still the one the form opened on", () => {
    expect(movedRefusal({ newest: 3 }, { newest: 3 })).toBeNull();
  });
});

describe("the page", () => {
  /** Mutation: always show the notice, or name the shown version as the newest. */
  it("says an older version is not the one runs are told, and nothing on the newest", () => {
    expect(olderVersionNotice(specify)).toBeNull();
    expect(olderVersionNotice({ version: 1, newest: 3 })).toBe(
      "You are reading v1. The newest is v3: that is the one the next run in a column that binds this skill is told.",
    );
  });

  it("names a seeded version's author as seeded, and an actor as recorded", () => {
    expect(authorLabel("")).toBe("seeded");
    expect(authorLabel("person:ana")).toBe("person:ana");
  });

  it("puts a multi-line description on one line, and a blank one as none", () => {
    expect(oneLine("Turn a card\n  into a spec\n")).toBe(
      "Turn a card into a spec",
    );
    expect(oneLine(" \n")).toBe("—");
  });

  /** Mutation: accept 0, a negative or a fraction — the server would answer not-found for a typo. */
  it("reads ?version= as a positive integer, and anything else as the newest", () => {
    expect(versionSearch("2")).toBe(2);
    expect(versionSearch(2)).toBe(2);
    for (const value of [
      "0",
      "-1",
      "1.5",
      "two",
      "",
      0,
      1.5,
      undefined,
      null,
    ]) {
      expect(versionSearch(value)).toBeUndefined();
    }
  });

  it("lists the history in the server's order, marking only the version shown", () => {
    const history: ReadonlyArray<SkillVersionSummary> = [3, 2, 1].map(
      (version) => ({
        name: "specify",
        version,
        description: "",
        createdAt: "2026-10-28T10:00:00.000Z",
        author: "",
      }),
    );
    expect(
      historyRows(history, 2).map((row) => [row.version, row.current]),
    ).toEqual([
      [3, false],
      [2, true],
      [1, false],
    ]);
  });
});
