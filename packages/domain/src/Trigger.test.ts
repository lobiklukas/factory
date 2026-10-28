/**
 * The pure half of the trigger seam (LOB-188): rule matching and prompt rendering.
 *
 * These are the two decisions an adapter must not make for itself — which rule claims an event,
 * and what text the session is actually told — so they live in the domain next to the shapes and
 * are tested with no database and no route.
 */
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { RepoSlug } from "@repo/domain/Session";
import {
  renderPrompt,
  resolveMapping,
  ruleClaims,
  ruleName,
  TriggerRule as TriggerRuleSchema,
  type TriggerEvent,
  type TriggerRule,
} from "./Trigger";

const repo = "acme/widgets" as RepoSlug;
const otherRepo = "acme/gadgets" as RepoSlug;

const event = (over: Partial<TriggerEvent> = {}): TriggerEvent => ({
  source: "linear",
  key: "issue-1",
  action: "create",
  title: "Fix the widget",
  body: "It wobbles.",
  labels: ["factory"],
  ...over,
});

const rules: ReadonlyArray<TriggerRule> = [
  { label: "factory", repo, baseRef: "release", prompt: "{{title}}: {{body}}" },
  {
    label: "factory",
    repo: otherRepo,
    prompt: "second rule for the same label",
  },
];

describe("resolveMapping", () => {
  it("maps the first rule whose label the event carries", () => {
    const mapping = resolveMapping(rules, event());
    expect(mapping).toEqual({
      repo,
      baseRef: "release",
      prompt: "Fix the widget: It wobbles.",
      label: "factory",
    });
  });

  it("takes the order of the rules as the operator's precedence", () => {
    const reordered = [rules[1], rules[0]].filter(
      (rule): rule is TriggerRule => rule !== undefined,
    );
    expect(resolveMapping(reordered, event())?.repo).toBe(otherRepo);
  });

  it("finds a rule by any label the event carries, not only the first", () => {
    const mapping = resolveMapping(
      [{ label: "triage", repo, prompt: "triage" }],
      event({ labels: ["priority", "triage"] }),
    );
    expect(mapping?.repo).toBe(repo);
    expect(mapping?.baseRef).toBeUndefined();
  });

  it("maps nothing when no rule matches, which is what makes it unmappable", () => {
    expect(resolveMapping(rules, event({ labels: ["unrelated"] }))).toBe(
      undefined,
    );
    expect(resolveMapping([], event())).toBeUndefined();
  });

  it("takes the repo the event names over the rule's, because a source that knows its own repo does (LOB-190)", () => {
    const mapping = resolveMapping(rules, event({ repo: otherRepo }));
    expect(mapping?.repo).toBe(otherRepo);
    // Everything else is still the rule's: the label is still what chose it.
    expect(mapping?.label).toBe("factory");
    expect(mapping?.prompt).toBe("Fix the widget: It wobbles.");
  });
});

describe("renderPrompt", () => {
  it("substitutes every variable the event carries", () => {
    expect(
      renderPrompt(
        "{{source}} {{key}} {{action}} [{{labels}}] {{title}} — {{body}}",
        event({ labels: ["factory", "urgent"] }),
      ),
    ).toBe(
      "linear issue-1 create [factory, urgent] Fix the widget — It wobbles.",
    );
  });

  it("leaves an unknown placeholder as written rather than dropping it", () => {
    expect(renderPrompt("hello {{name}}", event())).toBe("hello {{name}}");
  });

  it("is identity for a template with no placeholders", () => {
    expect(renderPrompt("just do the thing", event())).toBe(
      "just do the thing",
    );
  });
});

describe("a rule that names a team (LOB-266)", () => {
  const team: TriggerRule = { team: "ENG", repo, prompt: "team" };
  const both: TriggerRule = {
    label: "factory",
    team: "ENG",
    repo: otherRepo,
    prompt: "both",
  };

  it("claims an event only from its team, whatever labels it carries", () => {
    expect(ruleClaims(team, event({ labels: [], team: "ENG" }))).toBe(true);
    expect(ruleClaims(team, event({ labels: ["factory"], team: "OPS" }))).toBe(
      false,
    );
    // An event with no team is in no team, so a team rule does not claim it.
    expect(ruleClaims(team, event({ labels: ["factory"] }))).toBe(false);
  });

  it("claims a label and a team together only when both match", () => {
    expect(ruleClaims(both, event({ team: "ENG" }))).toBe(true);
    expect(ruleClaims(both, event({ team: "OPS" }))).toBe(false);
    expect(ruleClaims(both, event({ labels: ["other"], team: "ENG" }))).toBe(
      false,
    );
  });

  it("names itself in a reason: a label alone as it always did, a team and both as what they claim", () => {
    expect(ruleName({ label: "factory", repo, prompt: "" })).toBe("factory");
    expect(ruleName(team)).toBe("team ENG");
    expect(ruleName(both)).toBe("factory in team ENG");
    expect(resolveMapping([team], event({ team: "ENG" }))?.label).toBe(
      "team ENG",
    );
  });

  it("refuses to decode a rule that names neither, so a typo cannot be a rule that claims nothing", () => {
    const decode = Schema.decodeUnknownSync(TriggerRuleSchema);
    expect(() => decode({ repo: "acme/widgets", prompt: "x" })).toThrow(
      /label, a team, or both/,
    );
    expect(decode({ team: "ENG", repo: "acme/widgets", prompt: "x" })).toEqual({
      team: "ENG",
      repo: "acme/widgets",
      prompt: "x",
    });
  });

  it("refuses an empty label or team, which would claim nothing just as a missing one does", () => {
    const decode = Schema.decodeUnknownSync(TriggerRuleSchema);
    expect(() =>
      decode({ label: "", repo: "acme/widgets", prompt: "x" }),
    ).toThrow();
    expect(() =>
      decode({ team: "", repo: "acme/widgets", prompt: "x" }),
    ).toThrow();
    expect(() =>
      decode({ label: "docs", team: "", repo: "acme/widgets", prompt: "x" }),
    ).toThrow();
  });
});
