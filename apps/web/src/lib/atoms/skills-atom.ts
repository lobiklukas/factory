import { Effect } from "effect";
import { Atom } from "effect/reactivity";
import type { PutSkillInput } from "@repo/domain/Skill";
import { runtime } from "../atom";
import { RpcClient } from "../rpc-client";

/** The reactivity key a publish invalidates: every skill read re-runs once a put lands (D8). */
export const SKILLS_KEY = "skills";

/**
 * Every skill at its newest version, with the default definition's columns that bind it (D7's
 * `listSkills`): what `/skills` lists and where a skill page reads "used by".
 *
 * Read once per opening and again when a publish from this dashboard lands, not polled: a skill
 * changes only by a put, and a put from elsewhere is a reload away — unlike a board, nothing about a
 * skill moves on its own.
 */
export const skillsAtom = runtime
  .atom(
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      return yield* rpc.client.listSkills({});
    }),
  )
  .pipe(Atom.withReactivity([SKILLS_KEY]));

/**
 * One version of a skill (`getSkill`): the one named, or the newest when `version` is undefined —
 * which a publish moves, so the newest is re-read once one lands.
 */
export const skillAtom = Atom.family(
  (key: { readonly name: string; readonly version: number | undefined }) =>
    runtime
      .atom(
        Effect.gen(function* () {
          const rpc = yield* RpcClient;
          return yield* rpc.client.getSkill(
            key.version === undefined
              ? { name: key.name }
              : { name: key.name, version: key.version },
          );
        }),
      )
      .pipe(Atom.withReactivity([SKILLS_KEY])),
);

/** A skill's history, newest first, without the bodies (`listSkillVersions`, D8). */
export const skillVersionsAtom = Atom.family((name: string) =>
  runtime
    .atom(
      Effect.gen(function* () {
        const rpc = yield* RpcClient;
        return yield* rpc.client.listSkillVersions({ name });
      }),
    )
    .pipe(Atom.withReactivity([SKILLS_KEY])),
);

/**
 * Publishes a new version of a skill from the Edit form: `putSkill`, as `factory skill put` calls it,
 * so the version written is the server's `newest + 1` and no earlier one is touched (B2). The answer
 * is the server's record or its typed refusal; the page's body and history show the new version when
 * the reads `SKILLS_KEY` re-runs say it is there, not from this answer.
 */
export const putSkillAtom = runtime.fn(
  (input: PutSkillInput) =>
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      return yield* rpc.client.putSkill(input);
    }),
  { reactivityKeys: [SKILLS_KEY] },
);
