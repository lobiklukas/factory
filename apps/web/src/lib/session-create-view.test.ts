/**
 * The "New session" form's rules (E6). That the server binds the repo, cuts the worktree and names
 * the session from its first message is proven where it is computed (`packages/core`'s
 * `SessionService`); the browser drive (`.pi/skills/verify-web/session-new.mjs`) proves the page
 * sends nothing until a submit, and that a submit on a repo lands a worktree. These are the cases a
 * drive does not reach cheaply: a prompt of spaces, a prompt that must reach the server byte for
 * byte, a blank field left out rather than sent, a base ref with no repo, a budget that is not one.
 */
import { CostPrediction } from "@repo/domain/Cost";
import { CreateSessionInput, RepoSlug } from "@repo/domain/Session";
import type { RepoSummary } from "@repo/domain/Session";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  editSessionForm,
  EMPTY_SESSION_FORM,
  newSessionInput,
  NO_REPO,
  repoChoices,
  startRefusal,
  type SessionForm,
} from "./session-create-view";

const slug = Schema.decodeSync(RepoSlug);
const form = (over: Partial<SessionForm> = {}): SessionForm => ({
  ...EMPTY_SESSION_FORM,
  ...over,
});
const ranged = Schema.decodeSync(CostPrediction)({
  shape: "other",
  model: "faux/faux-1",
  basis: "model+shape",
  comparables: 4,
  history: 6,
  minimumComparables: 3,
  range: { low: 0.02, median: 0.025, high: 0.037 },
});
const row = (over: Partial<RepoSummary> = {}): RepoSummary => ({
  repo: slug("acme/widgets"),
  url: "",
  defaultBaseRef: "main",
  registeredAt: "2026-10-28T00:00:00.000Z",
  localPathIsGit: false,
  hasFactoryConfig: false,
  ...over,
});

describe("newSessionInput", () => {
  it("refuses an empty prompt, and one of nothing but whitespace, naming the prompt", () => {
    for (const prompt of ["", "   ", "\n\t "]) {
      expect(newSessionInput(form({ prompt }), undefined)).toEqual({
        ok: false,
        problem: {
          field: "prompt",
          message: "A session needs a prompt: the task it is delegated.",
        },
      });
    }
  });

  it("sends a bare prompt as the dashboard on no repo, with no title, model or budget", () => {
    expect(
      newSessionInput(form({ prompt: "Fix the flake" }), undefined),
    ).toEqual({
      ok: true,
      start: { create: { actor: "dashboard" }, content: "Fix the flake" },
    });
  });

  it("sends the prompt exactly as typed: its first user entry is the operator's words", () => {
    const prompt = "  Fix the flake\n\n  - in core/git.test.ts\n";
    const result = newSessionInput(form({ prompt }), undefined);
    expect(result.ok && result.start.content).toBe(prompt);
  });

  it("binds the repo and a trimmed base ref, and the payload is createSession's own", () => {
    const result = newSessionInput(
      form({
        prompt: "Fix it",
        repo: slug("acme/widgets"),
        baseRef: "  release/1.2 ",
        model: "faux/faux-spec",
        budget: " 2.5 ",
      }),
      undefined,
    );
    expect(result).toEqual({
      ok: true,
      start: {
        create: {
          actor: "dashboard",
          repo: "acme/widgets",
          baseRef: "release/1.2",
          model: "faux/faux-spec",
          budget: 2.5,
        },
        content: "Fix it",
      },
    });
    if (!result.ok) return;
    // What the client encodes is what the wire accepts: no field the schema would refuse.
    expect(Schema.decodeSync(CreateSessionInput)(result.start.create)).toEqual(
      result.start.create,
    );
  });

  // F17. Mutations: send `openPrOnSettle` whenever it is ticked (a scratch session is refused by the
  // server); never send it (the checkbox does nothing).
  it("asks for a PR on settle only when ticked and on a repo, and the payload is one the wire accepts", () => {
    const create = (over: Partial<SessionForm>) => {
      const result = newSessionInput(
        form({ prompt: "Fix it", ...over }),
        undefined,
      );
      return result.ok ? result.start.create : undefined;
    };

    expect(create({ repo: slug("acme/widgets"), openPr: true })).toMatchObject({
      repo: "acme/widgets",
      openPrOnSettle: true,
    });
    expect(create({ repo: slug("acme/widgets") })).not.toHaveProperty(
      "openPrOnSettle",
    );
    // Ticked, then the repo cleared: nothing is sent for it.
    expect(create({ openPr: true })).not.toHaveProperty("openPrOnSettle");
    const asked = create({ repo: slug("acme/widgets"), openPr: true });
    expect(Schema.decodeSync(CreateSessionInput)(asked ?? {})).toEqual(asked);
  });

  it("leaves out a blank base ref, so the registry's default applies", () => {
    const result = newSessionInput(
      form({ prompt: "Fix it", repo: slug("acme/widgets"), baseRef: "  " }),
      undefined,
    );
    expect(result.ok && result.start.create).toEqual({
      actor: "dashboard",
      repo: "acme/widgets",
    });
  });

  it("sends no base ref without a repo: there is no worktree for it to start", () => {
    const result = newSessionInput(
      form({ prompt: "Fix it", baseRef: "main" }),
      undefined,
    );
    expect(result.ok && result.start.create).toEqual({ actor: "dashboard" });
  });

  it("refuses a budget that is not a positive amount, and sends nothing", () => {
    for (const budget of ["0", "-1", "abc", "1e400", "Infinity"]) {
      const result = newSessionInput(
        form({ prompt: "Fix it", budget }),
        undefined,
      );
      expect(result.ok).toBe(false);
      expect(!result.ok && result.problem.field).toBe("budget");
    }
  });

  it("caps at the predicted high when asked, over a typed budget", () => {
    const result = newSessionInput(
      form({ prompt: "Fix it", capped: true, budget: "9" }),
      ranged,
    );
    expect(result.ok && result.start.create).toEqual({
      actor: "dashboard",
      budget: 0.037,
    });
  });

  it("refuses a cap with no range to cap at, rather than starting uncapped", () => {
    const result = newSessionInput(
      form({ prompt: "Fix it", capped: true }),
      undefined,
    );
    expect(!result.ok && result.problem.field).toBe("cap");
  });
});

describe("editSessionForm", () => {
  const capped = form({ prompt: "Fix it", capped: true, budget: "9" });

  it("unticks the cap when the model or the repo changes: either is another predicted range", () => {
    expect(editSessionForm(capped, "model", "faux/faux-2")).toEqual({
      ...capped,
      model: "faux/faux-2",
      capped: false,
    });
    expect(editSessionForm(capped, "repo", slug("acme/widgets"))).toEqual({
      ...capped,
      repo: slug("acme/widgets"),
      capped: false,
    });
    const onRepo = form({ ...capped, repo: slug("acme/widgets") });
    expect(editSessionForm(onRepo, "repo", undefined).capped).toBe(false);
  });

  it("keeps the cap on a prompt or base ref edit, and on choosing the repo or model already chosen", () => {
    expect(editSessionForm(capped, "prompt", "Fix it now").capped).toBe(true);
    expect(editSessionForm(capped, "baseRef", "release/1.2").capped).toBe(true);
    expect(editSessionForm(capped, "model", capped.model).capped).toBe(true);
    expect(editSessionForm(capped, "repo", undefined).capped).toBe(true);
  });

  it("changes the field it was given and no other", () => {
    expect(editSessionForm(form(), "budget", "2.50")).toEqual(
      form({ budget: "2.50" }),
    );
  });
});

describe("repoChoices", () => {
  it("offers no repo first, then every registered slug, flagging one that cuts no worktree", () => {
    expect(
      repoChoices([
        row({
          repo: slug("acme/api"),
          localPath: "/src/api",
          localPathIsGit: true,
          defaultBaseRef: "trunk",
        }),
        row(),
      ]),
    ).toEqual([
      { value: NO_REPO, repo: undefined, label: "No repo (scratch session)" },
      {
        value: "acme/api",
        repo: "acme/api",
        label: "acme/api",
        defaultBaseRef: "trunk",
      },
      {
        value: "acme/widgets",
        repo: "acme/widgets",
        label: "acme/widgets (no worktree: not runnable)",
        defaultBaseRef: "main",
      },
    ]);
  });

  it("offers only a scratch session before the registry has answered", () => {
    expect(repoChoices(undefined).map((choice) => choice.value)).toEqual([
      NO_REPO,
    ]);
  });
});

describe("startRefusal", () => {
  it("shows the server's own words, and the cause when it gave none", () => {
    expect(
      startRefusal(
        { message: "repo acme/api: failed to create worktree at nope" },
        "fallback",
      ),
    ).toBe("repo acme/api: failed to create worktree at nope");
    expect(startRefusal({ message: "" }, "connection reset")).toBe(
      "connection reset",
    );
    expect(startRefusal(undefined, "connection reset")).toBe(
      "connection reset",
    );
  });
});
