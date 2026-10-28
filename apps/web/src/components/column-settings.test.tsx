/** A column's settings (LOB-245): what the settings page and a lane's disclosure say about one column. */
import type { ReactNode } from "react";
import { renderToStaticMarkup as renderStatic } from "react-dom/server";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ColumnConfig } from "@repo/domain/Task";
import { ColumnSettings } from "./column-settings";

const column = (raw: unknown): ColumnConfig =>
  Schema.decodeUnknownSync(ColumnConfig)(raw);

const planning = column({
  name: "planning",
  kind: "working",
  role: "planner",
  model: { model: "faux/faux-plan", source: "role" },
  skills: ["planning", "plan-freshness"],
  requires: [
    {
      key: "plan_doc",
      description: "A plan document is attached",
      checked: false,
    },
    {
      key: "verified",
      description: "The change passed verification",
      checked: true,
    },
  ],
  exits: [{ to: "building", humanGate: "plan approval" }, { to: "canceled" }],
  wipLimit: 2,
});

const intake = column({
  name: "intake",
  kind: "resting",
  model: { model: "faux/faux-1", source: "deployment" },
  skills: [],
  requires: [],
  exits: [],
});

/** A router for the skill links (D8) to resolve against: a bare root, so a link's href is its path. */
const router = createRouter({
  routeTree: createRootRoute(),
  history: createMemoryHistory(),
});

const renderToStaticMarkup = (node: ReactNode): string =>
  renderStatic(
    <RouterContextProvider router={router}>{node}</RouterContextProvider>,
  );

/** The markup between an element's opening tag carrying `hook` and its first closing tag. */
const textAt = (markup: string, hook: string): ReadonlyArray<string> =>
  [...markup.matchAll(new RegExp(`${hook}[^>]*>([^<]*)<`, "g"))].map(
    (match) => match[1] ?? "",
  );

describe("ColumnSettings", () => {
  const markup = renderToStaticMarkup(<ColumnSettings column={planning} />);

  it("names the column's kind, role, and the model its role resolves to with where it came from", () => {
    expect(markup).toContain('data-column-settings="planning"');
    expect(textAt(markup, "data-column-kind")).toEqual(["working"]);
    expect(textAt(markup, "data-column-role")).toEqual(["planner"]);
    expect(textAt(markup, "data-column-model")).toEqual(["faux/faux-plan"]);
    expect(markup).toContain('data-column-model-source="role"');
    expect(markup).toContain("role model");
  });

  /** Mutation: mark every requirement checked, or drop the description. */
  it("marks an unchecked requirement 'not yet checked' and a checked one 'checked', each with its description", () => {
    expect(textAt(markup, "data-requirement-key")).toEqual([
      "plan_doc",
      "verified",
    ]);
    expect(textAt(markup, "data-requirement-state")).toEqual([
      "not yet checked",
      "checked",
    ]);
    expect(textAt(markup, "data-requirement-description")).toEqual([
      "A plan document is attached",
      "The change passed verification",
    ]);
  });

  /** Mutation: drop the gate, or lose an exit — the gated move would read as a run's to make. */
  it("lists every move out in order, the gated one with its gate's name", () => {
    expect(textAt(markup, "data-exit-to")).toEqual(["building", "canceled"]);
    expect(textAt(markup, "data-exit-gate")).toEqual(["plan approval"]);
    expect(markup).toContain('data-exit="building"');
  });

  /** Mutation: render the names as plain text again, or link every skill to one page. */
  it("lists the skills by name, each a link to its page, and the WIP limit", () => {
    expect(textAt(markup, "data-column-skill")).toEqual([
      "planning",
      "plan-freshness",
    ]);
    expect(
      [...markup.matchAll(/<a [^>]*data-column-skill-link[^>]*>/g)].map(
        (match) => /href="([^"]*)"/.exec(match[0])?.[1],
      ),
    ).toEqual(["/skills/planning", "/skills/plan-freshness"]);
    expect(textAt(markup, 'data-column-wip="2"')).toEqual([
      "at most 2 runs in flight",
    ]);
  });

  /** Mutation: render an empty list — "none" must read as a value, not as a missing section. */
  it("says none for a column with no role, skills, requirements or moves, and the deployment's model", () => {
    const bare = renderToStaticMarkup(<ColumnSettings column={intake} />);
    expect(textAt(bare, "data-column-role")).toEqual(["—"]);
    expect(bare).toContain('data-column-model-source="deployment"');
    expect(bare).toContain("deployment default");
    expect(bare).toContain("data-column-skills-none");
    expect(bare).toContain("data-column-requires-none");
    expect(bare).toContain("data-column-exits-none");
    expect(bare).not.toContain("data-column-wip");
  });
});
