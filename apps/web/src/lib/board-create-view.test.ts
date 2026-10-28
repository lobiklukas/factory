/**
 * The "New board" form's rules (C5). What the server makes of the payload (the pinned version, the
 * one board per repository) is proven where it is computed (`packages/core`'s `TaskService`); the
 * browser drive (`.pi/skills/verify-web/board-create.sh`) proves the page and the CLI agree. These
 * are the cases a drive does not reach cheaply: a slug in capitals, a definition list with no
 * default, the newest version sent as nothing at all, a refusal that names the board in the way.
 */
import {
  CreateBoardInput,
  DEFAULT_DEFINITION_ID,
  type DefinitionSummary,
} from "@repo/domain/Task";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  boardRefusal,
  chosenRepo,
  createBoardInput,
  initialBoardForm,
  NEWEST_VERSION,
  OTHER_REPO,
  versionChoices,
  type BoardForm,
} from "./board-create-view";

const definition = (id: string, versions: number[]): DefinitionSummary =>
  ({
    id,
    versions: versions.map((version) => ({
      version,
      name: `${id} ${version}`,
      createdAt: "2026-10-28T00:00:00.000Z",
    })),
  }) as unknown as DefinitionSummary;

const form = (over: Partial<BoardForm> = {}): BoardForm => ({
  repoPick: OTHER_REPO,
  repoText: "acme/widgets",
  definitionId: DEFAULT_DEFINITION_ID,
  version: NEWEST_VERSION,
  ...over,
});

describe("initialBoardForm", () => {
  /** Mutation: default to the first definition listed instead of the shipped one. */
  it("opens on the shipped default definition even when another sorts first", () => {
    const opened = initialBoardForm(
      [definition("alpha", [1]), definition("default", [1, 2])],
      [],
    );
    expect(opened.definitionId).toBe("default");
    expect(opened.version).toBe(NEWEST_VERSION);
  });

  it("falls back to the first definition when the server lists no default", () => {
    expect(initialBoardForm([definition("alpha", [1])], []).definitionId).toBe(
      "alpha",
    );
  });

  it("picks the first registered repository, or the typed slug when none is registered", () => {
    expect(initialBoardForm([], ["a/b", "c/d"]).repoPick).toBe("a/b");
    expect(initialBoardForm([], []).repoPick).toBe(OTHER_REPO);
  });
});

describe("chosenRepo", () => {
  it("reads the picked repository, and the typed one only beside Another", () => {
    expect(chosenRepo(form({ repoPick: "a/b", repoText: "x/y" }))).toBe("a/b");
    expect(chosenRepo(form({ repoPick: OTHER_REPO, repoText: "x/y" }))).toBe(
      "x/y",
    );
  });
});

describe("versionChoices", () => {
  /** Mutation: list versions oldest first, or leave the newest unnamed. */
  it("offers the newest by name first, then every version newest first", () => {
    expect(
      versionChoices(definition("default", [1, 3, 2])).map(
        (choice) => choice.label,
      ),
    ).toEqual([
      "Newest (v3: default 3)",
      "v3: default 3",
      "v2: default 2",
      "v1: default 1",
    ]);
  });

  it("offers only the newest for a definition it has not read", () => {
    expect(versionChoices(undefined)).toEqual([
      { value: NEWEST_VERSION, label: "Newest" },
    ]);
  });
});

describe("createBoardInput", () => {
  /** Mutation: send `definitionVersion: NaN` or `0` for the newest, which pins nothing the server resolves. */
  it("sends the newest as no version, so the server pins it", () => {
    const parsed = createBoardInput(form());
    expect(parsed).toEqual({
      ok: true,
      input: { repo: "acme/widgets", definitionId: "default" },
    });
    expect(parsed.ok && "definitionVersion" in parsed.input).toBe(false);
  });

  it("sends a named version as its number, and the payload decodes as the schema's own", () => {
    const parsed = createBoardInput(form({ version: "1" }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.input.definitionVersion).toBe(1);
    expect(() =>
      Schema.decodeSync(CreateBoardInput)(parsed.input),
    ).not.toThrow();
  });

  it("trims a pasted slug", () => {
    const parsed = createBoardInput(form({ repoText: "  acme/widgets\n" }));
    expect(parsed.ok && parsed.input.repo).toBe("acme/widgets");
  });

  /** Mutation: lowercase silently (the CLI refuses it) or send the slug and fail on the client's encode. */
  it("refuses a blank slug and one outside owner/name, naming the repo field and sending nothing", () => {
    for (const repoText of ["", "   ", "Acme/Widgets", "widgets", "a b/c"]) {
      const parsed = createBoardInput(form({ repoText }));
      expect(parsed.ok).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.problem.field).toBe("repo");
      expect(parsed.problem.message.length).toBeGreaterThan(0);
    }
  });

  it("refuses a definition id the schema cannot hold, naming the definition field", () => {
    const parsed = createBoardInput(form({ definitionId: "Not A Definition" }));
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.problem.field).toBe("definition");
  });

  it("leaves an unknown but well-formed definition to the server", () => {
    expect(createBoardInput(form({ definitionId: "nosuch" })).ok).toBe(true);
    expect(createBoardInput(form({ version: "99" })).ok).toBe(true);
  });

  it("refuses a version that is not a whole number", () => {
    for (const version of ["1.5", "abc"]) {
      expect(createBoardInput(form({ version })).ok).toBe(false);
    }
  });
});

describe("boardRefusal", () => {
  /** Mutation: drop the id, so the page cannot link to the board in the way. */
  it("names the existing board for BoardExists, with the server's words", () => {
    expect(
      boardRefusal(
        {
          _tag: "BoardExists",
          message: "acme/widgets already has board brd_x",
          boardId: "brd_x",
        },
        "fallback",
      ),
    ).toEqual({
      tag: "BoardExists",
      message: "acme/widgets already has board brd_x",
      existingBoardId: "brd_x",
    });
  });

  it("shows DefinitionNotFound verbatim, with no board to link", () => {
    const refusal = boardRefusal(
      { _tag: "DefinitionNotFound", message: 'no definition "nosuch"' },
      "fallback",
    );
    expect(refusal).toEqual({
      tag: "DefinitionNotFound",
      message: 'no definition "nosuch"',
    });
    expect("existingBoardId" in refusal).toBe(false);
  });

  it("falls back to the cause for an untyped failure or a refusal with no words", () => {
    expect(boardRefusal(undefined, "connection dropped")).toEqual({
      tag: "Unknown",
      message: "connection dropped",
    });
    expect(boardRefusal({ _tag: "X", message: "" }, "cause").message).toBe(
      "cause",
    );
  });
});
