import { Schema } from "effect";
import { RepoSlug } from "@repo/domain/Session";
import type { CreateBoardInput, DefinitionSummary } from "@repo/domain/Task";
import { DEFAULT_DEFINITION_ID, DefinitionId } from "@repo/domain/Task";
import { slugProblem } from "./repos-view";

/**
 * The /boards page's "New board" form (C5): what it holds, what it sends, and what it shows when
 * the server says no.
 *
 * The payload is the one `factory board create` sends for the same inputs — `createBoard`'s own,
 * the version present only when the person named one — so the server's default (the definition's
 * newest version, pinned when the board is made) is the same whichever door a board came through.
 * Pure on purpose, so the cases a screenshot cannot settle (a repository typed in capitals, a
 * definition list with no default, a refusal that names the board that already exists) are unit
 * cases.
 */

/**
 * The search value that opens the form: `/boards?new=board`. A URL rather than a click's state, so
 * the empty state, the header's action, another page or a reload all open the same form.
 */
export const NEW_BOARD = "board";

/** The repository select's value for "a repository that is not registered yet": type its slug. */
export const OTHER_REPO = "";

/** The version select's value for "the definition's newest, as the server pins it". */
export const NEWEST_VERSION = "";

/**
 * What the form holds, as chosen. `repoPick` is a registered repository's slug or `OTHER_REPO`, in
 * which case `repoText` is the slug typed; `version` is `NEWEST_VERSION` or a version number as the
 * select holds it.
 */
export type BoardForm = {
  readonly repoPick: string;
  readonly repoText: string;
  readonly definitionId: string;
  readonly version: string;
};

/**
 * The form the two lists open: the first registered repository (or, with none registered, the box
 * to type a slug into), the shipped `default` definition when the server lists it and the first one
 * when it does not, and the newest version.
 */
export const initialBoardForm = (
  definitions: ReadonlyArray<DefinitionSummary>,
  repos: ReadonlyArray<string>,
): BoardForm => ({
  repoPick: repos[0] ?? OTHER_REPO,
  repoText: "",
  definitionId:
    definitions.find((definition) => definition.id === DEFAULT_DEFINITION_ID)
      ?.id ??
    definitions[0]?.id ??
    DEFAULT_DEFINITION_ID,
  version: NEWEST_VERSION,
});

/** The slug the form means: the registered repository picked, or the one typed beside "Another". */
export const chosenRepo = (form: BoardForm): string =>
  form.repoPick === OTHER_REPO ? form.repoText : form.repoPick;

/** One option of the version select: the value it holds and what the person reads. */
export type VersionChoice = { readonly value: string; readonly label: string };

/**
 * The versions a definition offers, newest first, behind "Newest (vN)": the first option is what a
 * board made now gets, named so the person sees which version that is; each version after it pins
 * that one. `definition` absent (not listed, or not read yet) offers the newest alone.
 */
export const versionChoices = (
  definition: DefinitionSummary | undefined,
): ReadonlyArray<VersionChoice> => {
  const versions = [...(definition?.versions ?? [])].sort(
    (a, b) => b.version - a.version,
  );
  const newest = versions[0];
  return [
    {
      value: NEWEST_VERSION,
      label:
        newest === undefined
          ? "Newest"
          : `Newest (v${newest.version}: ${newest.name})`,
    },
    ...versions.map((entry) => ({
      value: String(entry.version),
      label: `v${entry.version}: ${entry.name}`,
    })),
  ];
};

/** Which field a problem is about, so the form marks that one and no other. */
export type BoardField = "repo" | "definition";

export type BoardProblem = {
  readonly field: BoardField;
  readonly message: string;
};

/**
 * The `createBoard` payload a form means, or the problem that stops it before any request.
 *
 * The repository is checked against `RepoSlug` here because that is the payload schema's: a slug
 * outside it would fail the client's own encode with a schema error instead of an answer the server
 * gave (`slugProblem` is the Repositories page's wording of the same rule). A definition or a version
 * that does not exist is not checked here: it is the server's `DefinitionNotFound`, shown in the
 * server's words, so there is one copy of that rule.
 */
export const createBoardInput = (
  form: BoardForm,
):
  | { readonly ok: true; readonly input: CreateBoardInput }
  | { readonly ok: false; readonly problem: BoardProblem } => {
  const repo = chosenRepo(form);
  const problem = slugProblem(repo);
  if (problem !== undefined) {
    return { ok: false, problem: { field: "repo", message: problem } };
  }
  const definitionId = Schema.decodeOption(DefinitionId)(form.definitionId);
  if (definitionId._tag === "None") {
    return {
      ok: false,
      problem: {
        field: "definition",
        message: `"${form.definitionId}" is not a definition id.`,
      },
    };
  }
  const version =
    form.version === NEWEST_VERSION ? undefined : Number(form.version);
  if (version !== undefined && !Number.isInteger(version)) {
    return {
      ok: false,
      problem: {
        field: "definition",
        message: `"${form.version}" is not a version number.`,
      },
    };
  }
  return {
    ok: true,
    input: {
      repo: Schema.decodeSync(RepoSlug)(repo.trim()),
      definitionId: definitionId.value,
      ...(version === undefined ? {} : { definitionVersion: version }),
    },
  };
};

/**
 * A refused create: which refusal it was, the server's message verbatim, and — for `BoardExists` —
 * the board the repository already has, so the person can open it instead.
 */
export type BoardRefusal = {
  readonly tag: string;
  readonly message: string;
  readonly existingBoardId?: string;
};

/**
 * What a failed `createBoard` shows. A typed refusal (`BoardExists`, `DefinitionNotFound`, a storage
 * error) is shown in the server's own words; anything else (a dropped connection) falls back to the
 * cause. `BoardExists` carries the id of the board that stands in the way.
 */
export const boardRefusal = (
  error:
    | {
        readonly _tag: string;
        readonly message: string;
        readonly boardId?: unknown;
      }
    | undefined,
  fallback: string,
): BoardRefusal => {
  if (error === undefined || error.message.length === 0) {
    return { tag: error?._tag ?? "Unknown", message: fallback };
  }
  return error._tag === "BoardExists" && typeof error.boardId === "string"
    ? {
        tag: error._tag,
        message: error.message,
        existingBoardId: error.boardId,
      }
    : { tag: error._tag, message: error.message };
};
