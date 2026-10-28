import { SkillService, summarizeSkills, TaskService } from "@repo/core";
import { SkillStorageError } from "@repo/domain/Skill";
import { DEFAULT_DEFINITION_ID } from "@repo/domain/Task";
import { SkillsRpc } from "@repo/domain/Rpc";
import { Effect } from "effect";
import { attributed } from "./Auth";

/**
 * The factory's skills over RPC (D7): thin calls into `SkillService`, which holds the rule that a
 * put is a new version and never an update.
 *
 * `listSkills` joins in the columns of the default definition's newest version that bind each skill
 * (`summarizeSkills`), read through `TaskService.getDefinition` as `factory board definition show`
 * reads it — which runs a put reaches, beside the version it would supersede. A deployment whose
 * default definition is gone lists its skills with no columns rather than failing the list; any other
 * definition read failure is a storage failure. `putSkill` is the credential's actor's (LOB-20).
 */
export const SkillsRpcHandlers = SkillsRpc.toLayer(
  Effect.gen(function* () {
    const skills = yield* SkillService;
    const tasks = yield* TaskService;
    const defaultColumns = tasks.getDefinition(DEFAULT_DEFINITION_ID).pipe(
      Effect.map((definition) => definition.columns),
      Effect.catchTag("DefinitionNotFound", () => Effect.succeed([])),
      Effect.mapError(
        (cause) =>
          new SkillStorageError({
            message: `read the ${DEFAULT_DEFINITION_ID} definition: ${cause.message}`,
          }),
      ),
    );
    return SkillsRpc.of({
      listSkills: () =>
        Effect.all([skills.list, defaultColumns]).pipe(
          Effect.map(([list, columns]) => summarizeSkills(list, columns)),
        ),
      getSkill: (input) => skills.get(input.name, input.version),
      listSkillVersions: (input) => skills.versions(input.name),
      putSkill: (input) => attributed(input).pipe(Effect.flatMap(skills.put)),
    });
  }),
);
