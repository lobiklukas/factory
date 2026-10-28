import type { BoardInstanceId, DefineBoardInput } from "@repo/domain/Task";
import { Effect } from "effect";
import { Atom } from "effect/reactivity";
import { runtime } from "../atom";
import { RpcClient } from "../rpc-client";
import { DEFINITIONS_KEY } from "./board-atom";

/**
 * The board a definition editor opens on (D6): `getBoard`, the instance and the pinned version as
 * stored — every field each column carries, not `getBoardConfig`'s description of it — so the draft
 * starts from exactly what the version declares and a field the editor has no control for goes back
 * to the server as it came. Read once per opening: the pin does not move under the page (B2).
 */
export const editedBoardAtom = Atom.family((boardId: BoardInstanceId) =>
  runtime.atom(
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      return yield* rpc.client.getBoard({ boardId });
    }),
  ),
);

/**
 * The skill library (D7): every name `listSkills` answers is one a column may bind, and the editor's
 * skill picker offers those and nothing typed. Read once per opening of the editor.
 */
export const skillsAtom = runtime.atom(
  Effect.gen(function* () {
    const rpc = yield* RpcClient;
    return yield* rpc.client.listSkills({});
  }),
);

/**
 * What else an authored version may name (D6): the requirement keys the factory knows and the roles
 * `defineBoard` accepts, which the editor's pickers offer; with no role table a role may also be typed.
 */
export const definitionVocabularyAtom = runtime.atom(
  Effect.gen(function* () {
    const rpc = yield* RpcClient;
    return yield* rpc.client.getDefinitionVocabulary({});
  }),
);

/**
 * Saves the editor's draft as a new version (D6): `defineBoard`, exactly as `factory board define`
 * calls it, so the server validates it and writes the id's newest version + 1 — never the pinned row
 * (B2). The answer is the version written (or the newest, unchanged) or `InvalidDefinition` with every
 * fault; the definition list re-reads, so the settings page names the new version.
 */
export const defineBoardAtom = runtime.fn(
  (input: DefineBoardInput) =>
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      return yield* rpc.client.defineBoard(input);
    }),
  { reactivityKeys: [DEFINITIONS_KEY] },
);
