import { Config, Effect, Option } from "effect";

/** Where a control plane listens when nothing says otherwise (docs/design.md, `apps/api`). */
export const DEFAULT_API_URL = "http://localhost:9000";

/**
 * Resolve the control plane base URL: the `--api` flag first, then `FACTORY_API_URL`, then
 * `API_URL`, then the local default.
 *
 * The skills pass `--api` explicitly so a verification run never depends on ambient environment;
 * the two variables exist so a developer can point the CLI at a running server once.
 */
export const resolveApiUrl = (
  flag: Option.Option<string>,
): Effect.Effect<string> =>
  Option.match(flag, {
    onSome: (url) => Effect.succeed(url),
    onNone: () =>
      Config.String("FACTORY_API_URL").pipe(
        Config.orElse(() => Config.String("API_URL")),
        Config.withDefault(DEFAULT_API_URL),
        // Every miss is covered by a default, so the only failure left is a broken
        // `ConfigProvider` — a programmer error, not a runtime condition.
        Effect.orDie,
      ),
  });
