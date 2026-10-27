import { SessionId } from "@repo/domain/Session";
import type { PullRequestStep } from "@repo/domain/PullRequest";
import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { resolveApiUrl } from "../api";
import { reportFailure, reportFailures } from "../errors";
import { SessionClient } from "../rpc";

/**
 * What `factory pr` prints for the PR step's answer: the link, or the reason there is none.
 *
 * Only an answer that carries a link is a success. `over-cap` and `no-change` are outcomes rather
 * than errors on the wire — the step ran, measured and decided — but the command was asked for a
 * PR and none exists, so it reports the outcome as the code a script branches on and exits
 * non-zero, as `withdraw` does for a message it could not take back. A caller that read only the
 * exit code must never be able to mistake "nothing was opened" for a link.
 */
export const prAnswer = (
  sessionId: string,
  step: PullRequestStep,
):
  | { readonly _tag: "Opened"; readonly lines: ReadonlyArray<string> }
  | {
      readonly _tag: "NotOpened";
      readonly code: string;
      readonly message: string;
    } => {
  switch (step.outcome) {
    case "opened":
    case "already-open":
      return {
        _tag: "Opened",
        lines: [
          `pr       ${step.url}`,
          `number   ${step.number}`,
          `outcome  ${step.outcome}`,
        ],
      };
    case "over-cap":
      return {
        _tag: "NotOpened",
        code: "over_cap",
        message: `session ${sessionId}'s diff is over the cap (${step.measured} ${step.limit}, at most ${step.cap}); no PR was opened`,
      };
    case "no-change":
      return {
        _tag: "NotOpened",
        code: "no_change",
        message: `session ${sessionId}'s branch has no change against its base; no PR was opened`,
      };
  }
};

/**
 * `factory pr <session-id>` — open the session's PR (LOB-86), through `openPullRequest` (LOB-213).
 *
 * The server chooses everything that decides *which* PR: the repo the session is bound to, its own
 * branch and the base it was cut from. The command names the session and, optionally, the title;
 * without `--title` the PR is titled after the session. A repeat answers the PR already opened,
 * tagged `already-open`, without asking the forge again.
 *
 * The forge's and the credential's failures arrive typed (`PrError`, `CredentialError`) and are
 * printed as `pr_error` / `credential_error` with the server's message and a non-zero exit — so a
 * process with no GitHub path says so, rather than leaving a caller to invent a link.
 */
export const prCommand = Command.make(
  "pr",
  {
    sessionId: Argument.String("session-id").pipe(
      Argument.withDescription("The session whose branch the PR publishes"),
      Argument.withSchema(SessionId),
    ),
    title: Flag.String("title").pipe(
      Flag.withDescription("The PR's title (defaults to the session's)"),
      Flag.optional,
    ),
    api: Flag.String("api").pipe(
      Flag.withDescription("Control plane base URL"),
      Flag.optional,
    ),
  },
  Effect.fnUntraced(function* ({ sessionId, title, api }) {
    const apiUrl = yield* resolveApiUrl(api);

    const program = Effect.gen(function* () {
      const { client } = yield* SessionClient;
      const named = Option.getOrUndefined(title)?.trim() ?? "";
      const prTitle =
        named.length > 0
          ? named
          : (yield* client.getSession({ sessionId })).session.title;
      if (prTitle.trim().length === 0) {
        return yield* reportFailure(
          "invalid_input",
          `session ${sessionId} has no title; name the PR with --title`,
        );
      }
      const step = yield* client.openPullRequest({
        sessionId,
        title: prTitle,
      });
      const answer = prAnswer(sessionId, step);
      if (answer._tag === "NotOpened") {
        return yield* reportFailure(answer.code, answer.message);
      }
      for (const line of answer.lines) yield* Console.log(line);
    });

    yield* reportFailures(Effect.provide(program, SessionClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription("Open a session's pull request"),
  Command.withExamples([
    {
      command: "factory pr ses_00000000000000000000000000",
      description:
        "The session's branch onto its base, titled after the session",
    },
  ]),
);
