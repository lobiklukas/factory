import type { ServerInfo } from "@repo/domain/Server";

/**
 * The New session form's model picker (LOB-274): which models it offers, how each reads, and what
 * a choice puts on `createSession`.
 *
 * The models are the server's own `getServerInfo.models` — the catalog `createSession` resolves a
 * model against — so the picker never offers one the server would refuse, and never invents one the
 * dashboard believes in. The first choice is no choice: the session then runs what the server would
 * give it anyway (its column role's model, else `DEFAULT_MODEL`, else the backend's own), which is
 * why picking it sends no `model` at all rather than echoing the default back. Pure, so the labels
 * and the payload are unit cases rather than screenshots.
 */

/** The picker's value for "let the server decide". */
export const SERVER_DEFAULT = "";

export type ModelChoice = {
  /** What the `<option>` carries: `SERVER_DEFAULT`, or a `provider/modelId`. */
  readonly value: string;
  readonly label: string;
};

/**
 * The picker's options for what the server said it serves. Before it has answered (or when it
 * could not), only the server's default: a session can still be started, on whatever the server
 * runs. Each model is named as the catalog names it; the deployment's default and the roles that
 * run a model are said beside it, so an operator picking a cheaper model knows which one the rest
 * of the board is on.
 */
export const modelChoices = (
  info: Pick<ServerInfo, "defaultModel" | "models" | "roleModels"> | undefined,
): readonly ModelChoice[] => {
  if (info === undefined) {
    return [{ value: SERVER_DEFAULT, label: "Server default" }];
  }
  return [
    { value: SERVER_DEFAULT, label: `Server default (${info.defaultModel})` },
    ...info.models.map((model) => {
      const notes = [
        ...(model === info.defaultModel ? ["default"] : []),
        ...info.roleModels
          .filter((row) => row.model === model)
          .map((row) => row.role),
      ];
      return {
        value: model,
        label: notes.length === 0 ? model : `${model} (${notes.join(", ")})`,
      };
    }),
  ];
};

/** What a choice adds to `createSession`: nothing for the server's default, the model otherwise. */
export const modelInput = (choice: string): { readonly model?: string } =>
  choice === SERVER_DEFAULT ? {} : { model: choice };
