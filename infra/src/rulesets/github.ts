/**
 * The repository-rulesets half of GitHub's REST API (LOB-30): the five calls the reconciler needs,
 * as one value built over Effect's `HttpClient`.
 *
 * - `GET /repos/{owner}/{repo}/rulesets?includes_parents=false` — the repository's own rulesets,
 *   paged (`per_page=100`). The list carries ids and names only, never the rules.
 * - `GET /repos/{owner}/{repo}/rulesets/{id}` — one ruleset in full. `bypass_actors` is answered
 *   only to a caller with write access to the ruleset, which is why the reader is an admin token.
 * - `POST /repos/{owner}/{repo}/rulesets`, `PUT …/{id}`, `DELETE …/{id}` — create, replace, remove.
 *
 * This is the "custom provider" D15 names, minus Alchemy's resource wrapper: Alchemy v2 is a
 * prerelease that needs a newer `effect` than this repo pins, so the provider is plain Effect code a
 * future `infra/alchemy.run.ts` can wrap without changing what it calls. The token is the
 * operator's, never the factory's push credential: an identity that can edit a ruleset can delete
 * the boundary it is supposed to be held by.
 */
import { Effect, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import type { DeclaredRuleset } from "./policy";

/** A call to the rulesets API that did not answer what was asked. */
export class RulesetsApiError extends Schema.TaggedError<RulesetsApiError>()(
  "RulesetsApiError",
  {
    operation: Schema.Literals(["list", "get", "create", "update", "delete"]),
    repo: Schema.String,
    /** The HTTP status GitHub answered, when it answered at all. */
    status: Schema.optional(Schema.Finite),
    message: Schema.String,
  },
) {}

const RefName = Schema.Struct({
  include: Schema.optional(Schema.Array(Schema.String)),
  exclude: Schema.optional(Schema.Array(Schema.String)),
});

/** A rule as GitHub answers it: a type, and parameters whose shape depends on it. */
export const LiveRule = Schema.Struct({
  type: Schema.String,
  parameters: Schema.optional(
    Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
  ),
});
export interface LiveRule extends Schema.Schema.Type<typeof LiveRule> {}

export const BypassActor = Schema.Struct({
  actor_id: Schema.optional(Schema.NullOr(Schema.Finite)),
  actor_type: Schema.String,
  bypass_mode: Schema.optional(Schema.String),
});
export interface BypassActor extends Schema.Schema.Type<typeof BypassActor> {}

/** One ruleset in full, as `GET …/rulesets/{id}` answers it. */
export const LiveRuleset = Schema.Struct({
  id: Schema.Finite,
  name: Schema.String,
  target: Schema.optional(Schema.String),
  source_type: Schema.optional(Schema.String),
  enforcement: Schema.String,
  conditions: Schema.optional(
    Schema.NullOr(Schema.Struct({ ref_name: Schema.optional(RefName) })),
  ),
  rules: Schema.optional(Schema.Array(LiveRule)),
  /** Absent when the reading token may not see who bypasses: not the same as "nobody". */
  bypass_actors: Schema.optional(Schema.Array(BypassActor)),
  /** `never` for a reader the ruleset binds; anything else means the reader is exempt. */
  current_user_can_bypass: Schema.optional(Schema.String),
});
export interface LiveRuleset extends Schema.Schema.Type<typeof LiveRuleset> {}

/** One entry of the list: enough to find a ruleset by name. */
export const RulesetSummary = Schema.Struct({
  id: Schema.Finite,
  name: Schema.String,
  source_type: Schema.optional(Schema.String),
});
export interface RulesetSummary extends Schema.Schema.Type<
  typeof RulesetSummary
> {}

/** The rulesets API for one token and API root. */
export type RulesetsClient = {
  readonly list: (
    repo: string,
  ) => Effect.Effect<ReadonlyArray<RulesetSummary>, RulesetsApiError>;
  readonly get: (
    repo: string,
    id: number,
  ) => Effect.Effect<LiveRuleset, RulesetsApiError>;
  readonly create: (
    repo: string,
    ruleset: DeclaredRuleset,
  ) => Effect.Effect<LiveRuleset, RulesetsApiError>;
  readonly update: (
    repo: string,
    id: number,
    ruleset: DeclaredRuleset,
  ) => Effect.Effect<LiveRuleset, RulesetsApiError>;
  readonly remove: (
    repo: string,
    id: number,
  ) => Effect.Effect<void, RulesetsApiError>;
};

export type RulesetsClientOptions = {
  /** The API root, e.g. `https://api.github.com` or a loopback fake. */
  readonly apiUrl: string;
  /** The operator's token: needs the repository's Administration permission. */
  readonly token: Redacted.Redacted<string>;
};

const PAGE_SIZE = 100;

type Operation = RulesetsApiError["operation"];

/** The rulesets client over the ambient `HttpClient`. */
export const makeRulesetsClient = (
  options: RulesetsClientOptions,
): Effect.Effect<RulesetsClient, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const root = options.apiUrl.replace(/\/+$/, "");
    const headers = {
      authorization: `Bearer ${Redacted.value(options.token)}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    };
    const base = (repo: string) => `${root}/repos/${repo}/rulesets`;

    const failed = (
      operation: Operation,
      repo: string,
      message: string,
      status?: number,
    ) =>
      new RulesetsApiError({
        operation,
        repo,
        message,
        ...(status === undefined ? {} : { status }),
      });

    /** Send one request and decode a 2xx answer, naming GitHub's status when it refused. */
    const send = <A, E>(
      operation: Operation,
      repo: string,
      request: HttpClientRequest.HttpClientRequest,
      decode: (
        response: HttpClientResponse.HttpClientResponse,
      ) => Effect.Effect<A, E>,
    ): Effect.Effect<A, RulesetsApiError> =>
      http.execute(request).pipe(
        Effect.mapError(() =>
          failed(operation, repo, "GitHub could not be reached"),
        ),
        Effect.flatMap((response) =>
          response.status >= 200 && response.status < 300
            ? decode(response).pipe(
                Effect.mapError(() =>
                  failed(
                    operation,
                    repo,
                    "GitHub's answer could not be read",
                    response.status,
                  ),
                ),
              )
            : Effect.fail(
                failed(
                  operation,
                  repo,
                  `GitHub answered HTTP ${response.status}`,
                  response.status,
                ),
              ),
        ),
      );

    const withBody = (
      operation: Operation,
      repo: string,
      request: HttpClientRequest.HttpClientRequest,
      ruleset: DeclaredRuleset,
    ) =>
      HttpClientRequest.bodyJson(request, ruleset).pipe(
        Effect.mapError(() =>
          failed(operation, repo, "the ruleset could not be encoded"),
        ),
      );

    const decodeRuleset = HttpClientResponse.schemaBodyJson(LiveRuleset);

    const list = (repo: string) =>
      Effect.gen(function* () {
        const found: Array<RulesetSummary> = [];
        for (let page = 1; ; page += 1) {
          const batch = yield* send(
            "list",
            repo,
            HttpClientRequest.get(
              `${base(repo)}?includes_parents=false&per_page=${PAGE_SIZE}&page=${page}`,
              { headers },
            ),
            HttpClientResponse.schemaBodyJson(Schema.Array(RulesetSummary)),
          );
          found.push(...batch);
          if (batch.length < PAGE_SIZE) return found;
        }
      });

    return {
      list,
      get: (repo, id) =>
        send(
          "get",
          repo,
          HttpClientRequest.get(`${base(repo)}/${id}`, { headers }),
          decodeRuleset,
        ),
      create: (repo, ruleset) =>
        withBody(
          "create",
          repo,
          HttpClientRequest.post(base(repo), { headers }),
          ruleset,
        ).pipe(
          Effect.flatMap((request) =>
            send("create", repo, request, decodeRuleset),
          ),
        ),
      update: (repo, id, ruleset) =>
        withBody(
          "update",
          repo,
          HttpClientRequest.put(`${base(repo)}/${id}`, { headers }),
          ruleset,
        ).pipe(
          Effect.flatMap((request) =>
            send("update", repo, request, decodeRuleset),
          ),
        ),
      remove: (repo, id) =>
        send(
          "delete",
          repo,
          HttpClientRequest.delete(`${base(repo)}/${id}`, { headers }),
          () => Effect.void,
        ),
    } satisfies RulesetsClient;
  });
