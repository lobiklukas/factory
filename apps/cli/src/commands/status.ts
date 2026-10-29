import { Console, Effect } from "effect";
import { Command, Flag } from "effect/cli";
import type { ServerInfo } from "@repo/domain/Server";
import { resolveApiUrl } from "../api";
import { reportFailures } from "../errors";
import { BoardClient } from "../rpc";
import { formatDollars } from "../transcript";

/**
 * The line `factory run` prints under a faux backend (LOB-272), whose reader is the person who just
 * watched a scripted answer scroll past and has no other signal that it was one.
 *
 * `warning: faux backend` is the part a script matches; the rest is the server's own sentence for
 * why (`ServerInfo.warnings`: chosen by `MODEL_BACKEND`, or no credential resolved and which to
 * set), so the CLI repeats the boot's words rather than inventing its own.
 */
export const fauxWarning = (info: ServerInfo): string | undefined =>
  info.backend === "faux"
    ? `warning: faux backend, sessions do not reach a real model${
        info.warnings[0] === undefined ? "" : ` (${info.warnings[0]})`
      }`
    : undefined;

/**
 * The `model` line and, under a faux backend, the warning under it that `factory run` prints once the
 * session exists. `info` is absent when the server could not answer `getServerInfo`: the run then
 * loses its warning, never its model line.
 */
export const runModelLines = (
  model: string | undefined,
  info: ServerInfo | undefined,
): readonly string[] => {
  const warning = info === undefined ? undefined : fauxWarning(info);
  return warning === undefined
    ? [`model ${model ?? "unknown"}`]
    : [`model ${model ?? "unknown"}`, warning];
};

const list = (items: readonly string[]): string =>
  items.length === 0 ? "none" : items.join(", ");

/**
 * The lines `factory status` prints: one `name value` per fact `getServerInfo` answered, in the
 * order an operator reads them — which model backend and why first.
 *
 * Every value is configuration the boot resolved, and the answer carries no secret (LOB-269): a
 * credential is the mode that authenticated, a webhook route whether it is armed. Nothing is
 * filtered here; a line is printed for every field, so a field the server adds is a reason to add a
 * line, not a silent omission.
 */
export const statusLines = (info: ServerInfo): readonly string[] => {
  const model = info.credentialMode.model;
  const write = info.linearWriteBack;
  return [
    `backend ${info.backend}`,
    `selected-by ${info.selectedBy}`,
    `reason ${info.reason}`,
    ...info.warnings.map((warning) => `warning ${warning}`),
    `default-model ${info.defaultModel}`,
    ...info.roleModels.map((row) => `role-model ${row.role} ${row.model}`),
    // A role's fallback chain (S-model-provider-breadth), in the order a run moves down it.
    ...(info.roleFallbacks ?? []).map(
      (row) => `role-fallback ${row.role} ${row.models.join(" | ")}`,
    ),
    `models ${list(info.models)}`,
    `approval-required ${list(info.approvalRequired)}`,
    `default-budget ${info.defaultBudget === undefined ? "none" : formatDollars(info.defaultBudget)}`,
    `model-credential ${model === null ? "none" : `${model.source} (${model.type})`}`,
    `forge-credential ${info.credentialMode.forge}`,
    `reviewer-credential ${info.credentialMode.reviewer}`,
    ...info.webhooks.map(
      (hook) =>
        `webhook ${hook.route} ${hook.armed ? "armed" : "unarmed"} (${hook.variable})`,
    ),
    `linear-write-back ${
      write.enabled && write.states !== undefined
        ? `on (started ${write.states.started}, in review ${write.states.inReview}, done ${write.states.done})`
        : "off"
    }`,
    `sandbox ${info.sandbox}`,
  ];
};

/**
 * `factory status` — what the control plane is running (LOB-269's `getServerInfo`).
 *
 * The first thing to ask when an answer looks too tidy: it names the model backend and what chose
 * it, the default and role models, the gate and budget, which credential modes are in use (never a
 * value), and which webhook routes are armed. It reads the process's boot facts, so it answers even
 * while the database is down.
 */
export const statusCommand = Command.make(
  "status",
  {
    api: Flag.String("api").pipe(
      Flag.withDescription("Control plane base URL"),
      Flag.optional,
    ),
  },
  Effect.fnUntraced(function* ({ api }) {
    const apiUrl = yield* resolveApiUrl(api);

    const program = Effect.gen(function* () {
      const { client } = yield* BoardClient;
      const info = yield* client.getServerInfo({});
      for (const line of statusLines(info)) {
        yield* Console.log(line);
      }
    });

    yield* reportFailures(Effect.provide(program, BoardClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription(
    "Show what the control plane runs: model backend and why, models, credentials, routes",
  ),
  Command.withExamples([
    {
      command: "factory status",
      description: "Is this control plane on a real model or the scripted one?",
    },
  ]),
);
