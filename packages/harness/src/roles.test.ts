/**
 * A column's role resolves to its model and its tool policy, in one place (docs/board.md B6,
 * LOB-207).
 *
 * The first half is the table: `resolveRole`, `parseRoleModels` and `resolveRoleModels` are pure
 * (or fail with a typed refusal), so which model and which tools a role gets is a row here. The
 * second half is the install site: one deployment — one faux access publishing two models, one role
 * table — opens a run per role through `openSession`, and each run's *own log* says which model
 * answered it (`pi.usage`, keyed by the model a request went to) and which tools its requests
 * offered. Neither is the resolution grading itself: the usage is what the provider was called
 * with, and the offered tools are the transcript's system messages, which is what the model saw.
 *
 * No database: Pi Durable's in-memory storage and the faux provider, so this runs in the default
 * gate. `packages/core`'s `SessionService.test.ts` drives the same two roles through real cards.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  NO_ROLE_MODELS,
  parseRoleModels,
  resolveRole,
  resolveRoleModels,
  type RoleModels,
  type RunProfile,
} from "./loader";
import {
  createFauxModelAccess,
  createModelAccess,
  DEFAULT_ANTHROPIC_MODEL,
  modelAccessFor,
  modelKey,
  type ModelAccess,
} from "./models";
import { STAGE_REFUSED_TOOLS } from "./policy";
import {
  closeHarness,
  openSession,
  readOfferedTools,
  readSessionLog,
  submitMessage,
} from "./session";

const context = BACKGROUND_CONTEXT;

/**
 * One deployment: the faux backend publishing its default and a second model, which is the model
 * the role table below gives the specifier. `faux-1` first, so it is the deployment's own model.
 */
const deployment = createFauxModelAccess({
  fauxModels: ["faux-1", "faux-spec"],
});

/** The deployment's role table, resolved the way `apps/api` resolves `ROLE_MODELS` at boot. */
const roles: RoleModels = Effect.runSync(
  parseRoleModels("specifier=faux/faux-spec").pipe(
    Effect.flatMap((declared) =>
      resolveRoleModels(deployment.access, declared),
    ),
  ),
);

const run = (column: string, role?: string): RunProfile => ({
  column,
  ...(role === undefined ? {} : { role }),
  skills: [],
});

/** The failure an effect ends with, as its message, or the value it succeeded with. */
const outcome = <A, E extends { readonly message: string }>(
  effect: Effect.Effect<A, E>,
): { readonly ok: true; readonly value: A } | { readonly error: string } =>
  Effect.runSync(
    effect.pipe(
      Effect.match({
        onFailure: (error) => ({ error: error.message }),
        onSuccess: (value) => ({ ok: true as const, value }),
      }),
    ),
  );

describe("resolveRole", () => {
  it("gives a role with a row its model, and every other run the deployment's", () => {
    const model = (profile: RunProfile | undefined) =>
      modelKey(resolveRole(profile, deployment.access, roles).model);

    expect(model(run("specifying", "specifier"))).toBe("faux/faux-spec");
    // A board that renames the column keeps the model: the row is the role's.
    expect(model(run("clarifying", "specifier"))).toBe("faux/faux-spec");
    expect(model(run("building", "builder"))).toBe("faux/faux-1");
    // A role nobody configured, a column with no role, and a session with no card.
    expect(model(run("testing", "tester"))).toBe("faux/faux-1");
    expect(model(run("intake"))).toBe("faux/faux-1");
    expect(model(undefined)).toBe("faux/faux-1");
    // A role is free text: `constructor` must not find `Object.prototype`'s.
    expect(model(run("odd", "constructor"))).toBe("faux/faux-1");
    // No table at all is every run on the deployment's model.
    expect(
      modelKey(
        resolveRole(run("specifying", "specifier"), deployment.access).model,
      ),
    ).toBe("faux/faux-1");
  });

  it("withholds the stage's refused tools from a read-only role, and nothing from the rest", () => {
    const specifier = resolveRole(
      run("specifying", "specifier"),
      deployment.access,
      roles,
    );
    expect([...specifier.withheldTools].sort()).toEqual([
      "edit",
      "verify",
      "write",
    ]);
    expect(specifier.stage).toEqual({
      stage: "specifying",
      column: "specifying",
      role: "specifier",
    });

    const builder = resolveRole(
      run("building", "builder"),
      deployment.access,
      roles,
    );
    expect([...builder.withheldTools]).toEqual([]);
    expect(builder.stage).toBeUndefined();
    expect([
      ...resolveRole(undefined, deployment.access, roles).withheldTools,
    ]).toEqual([]);
  });

  it("keeps the model and the tool policy independent: a row changes no tool, a stage no model", () => {
    const spec = roles.get("specifier");
    if (spec === undefined) throw new Error("the table resolves the specifier");
    const table: RoleModels = new Map([["builder", spec]]);
    const builder = resolveRole(
      run("building", "builder"),
      deployment.access,
      table,
    );
    expect(modelKey(builder.model)).toBe("faux/faux-spec");
    expect([...builder.withheldTools]).toEqual([]);

    const specifier = resolveRole(
      run("specifying", "specifier"),
      deployment.access,
      NO_ROLE_MODELS,
    );
    expect(modelKey(specifier.model)).toBe("faux/faux-1");
    expect(specifier.withheldTools).toBe(STAGE_REFUSED_TOOLS);
  });

  it("offers the spec tool to the specifier role alone, whatever its column is called (LOB-238)", () => {
    const writesSpec = (profile: RunProfile | undefined) =>
      resolveRole(profile, deployment.access, roles).writesSpec;

    expect(writesSpec(run("specifying", "specifier"))).toBe(true);
    expect(writesSpec(run("clarifying", "specifier"))).toBe(true);
    expect(writesSpec(run("planning", "planner"))).toBe(false);
    expect(writesSpec(run("building", "builder"))).toBe(false);
    expect(writesSpec(run("specifying"))).toBe(false);
    expect(writesSpec(run("odd", "constructor"))).toBe(false);
    expect(writesSpec(undefined)).toBe(false);
  });

  it("offers the review tool to a review run alone, and makes it read-only whatever its role (LOB-36)", () => {
    const resolved = (profile: RunProfile | undefined) =>
      resolveRole(profile, deployment.access, roles);
    const reviewing = (profile: RunProfile): RunProfile => ({
      ...profile,
      reviewing: true,
    });

    const review = resolved(reviewing(run("review", "reviewer")));
    expect(review.writesReview).toBe(true);
    expect(review.withheldTools).toBe(STAGE_REFUSED_TOOLS);
    expect(review.stage?.stage).toBe("reviewing");
    expect(review.writesSpec).toBe(false);
    // The column's role still picks the model: a review on a board whose column is called something
    // else, under another role, is still read-only and still reviews.
    expect(
      resolved(reviewing(run("second-look", "auditor"))).writesReview,
    ).toBe(true);
    // A person's run in the review column is not a review.
    const person = resolved(run("review", "reviewer"));
    expect(person.writesReview).toBe(false);
    expect(person.stage).toBeUndefined();
    expect(resolved(run("specifying", "specifier")).writesReview).toBe(false);
    expect(resolved(run("building", "builder")).writesReview).toBe(false);
    expect(resolved(undefined).writesReview).toBe(false);
  });
});

describe("the deployment's role table", () => {
  it("reads role=provider/modelId rows, skipping blanks", () => {
    const parsed = outcome(
      parseRoleModels(
        " specifier = anthropic/claude-haiku-4-5 ,, reviewer=anthropic/claude-opus-4-5",
      ),
    );
    expect(parsed).toEqual({
      ok: true,
      value: new Map([
        ["specifier", "anthropic/claude-haiku-4-5"],
        ["reviewer", "anthropic/claude-opus-4-5"],
      ]),
    });
    expect(outcome(parseRoleModels(""))).toEqual({
      ok: true,
      value: new Map(),
    });
  });

  it("refuses a row it cannot read, and a role given two models", () => {
    expect(outcome(parseRoleModels("specifier"))).toEqual({
      error: 'role model "specifier" is not role=provider/modelId',
    });
    expect(outcome(parseRoleModels("=faux/faux-1"))).toEqual({
      error: 'role model "=faux/faux-1" is not role=provider/modelId',
    });
    expect(outcome(parseRoleModels("specifier="))).toEqual({
      error: 'role model "specifier=" is not role=provider/modelId',
    });
    expect(
      outcome(
        parseRoleModels("specifier=faux/faux-1,specifier=faux/faux-spec"),
      ),
    ).toEqual({ error: "role specifier is given a model twice" });
  });

  it("resolves each row against the catalog, and refuses a model the process does not serve", () => {
    const resolved = outcome(
      resolveRoleModels(
        deployment.access,
        new Map([["specifier", "faux/faux-spec"]]),
      ),
    );
    if (!("ok" in resolved)) throw new Error(resolved.error);
    const access = resolved.value.get("specifier");
    expect(access?.modelId).toBe("faux-spec");
    // The same registry as the deployment's, so the harness can serve it.
    expect(access?.models).toBe(deployment.access.models);
    expect(access?.contextWindow).toBeGreaterThan(0);

    expect(
      outcome(
        resolveRoleModels(
          deployment.access,
          new Map([["specifier", "faux/faux-9"]]),
        ),
      ),
    ).toEqual({
      error:
        "role specifier names model faux/faux-9, which this process does not serve",
    });
    expect(
      outcome(
        resolveRoleModels(deployment.access, new Map([["specifier", "faux"]])),
      ),
    ).toEqual({
      error:
        "role specifier names model faux, which this process does not serve",
    });
  });
});

/**
 * A model that calls `write` on its first request whether or not it was offered the tool — the
 * model that ignores its tool list — and then answers `done`.
 */
const callsWriteOnce = (path: string): ModelAccess => {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  let called = false;
  const step: FauxResponseFactory = () => {
    faux.appendResponses([step]);
    if (called) return fauxAssistantMessage("done");
    called = true;
    return fauxAssistantMessage(
      fauxToolCall("write", { path, content: "spec" }),
      { stopReason: "toolUse" },
    );
  };
  faux.setResponses([step]);
  return {
    backend: "faux",
    models,
    provider: "faux",
    modelId: faux.models[0].id,
    contextWindow: faux.models[0].contextWindow,
  };
};

/** What one run in one deployment did: the models its log was billed for, and the tools offered. */
const runIn = (
  profile: RunProfile | undefined,
  options: {
    readonly model?: ModelAccess;
    readonly roles?: RoleModels;
    readonly sessionModel?: ModelAccess;
  } = {},
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const storage = new MemoryStorage();
      const cwd = mkdtempSync(join(tmpdir(), "factory-roles-"));
      const { harness, root } = yield* openSession({
        storage,
        model: options.model ?? deployment.access,
        roles: options.roles ?? roles,
        ...(options.sessionModel === undefined
          ? {}
          : { sessionModel: options.sessionModel }),
        cwd,
        ...(profile === undefined ? {} : { run: profile }),
      });
      const submitted = yield* submitMessage(root, { content: "go" });
      const settled = yield* Effect.promise(() =>
        submitted.submission.wait(context),
      );
      const agent = yield* Effect.promise(() => root.agent(context));
      const log = yield* readSessionLog(storage);
      const offered = yield* readOfferedTools(storage);
      yield* closeHarness(harness);
      return {
        status: settled.status,
        cwd,
        /** Every model a request of this run went to, from the run's own usage document. */
        models: log.usage.models.map((entry) => entry.key),
        /** What the requests offered, from the system messages the log committed. */
        offered,
        /** The model the conversation is pinned to, as Pi Durable resolved it. */
        pinned: agent.model,
        entries: log.entries,
      };
    }),
  );

describe("two roles in one deployment", () => {
  it("run different models, and an unknown role runs the deployment's", async () => {
    const specifying = await runIn(run("specifying", "specifier"));
    const building = await runIn(run("building", "builder"));
    const unknown = await runIn(run("testing", "tester"));
    const scratch = await runIn(undefined);

    for (const ran of [specifying, building, unknown, scratch]) {
      expect(ran.status).toBe("done");
    }
    // The faux turn is two requests (call bash, then reply); every one went to the role's model.
    expect(specifying.models).toEqual(["faux/faux-spec"]);
    expect(specifying.pinned).toEqual({
      provider: "faux",
      modelId: "faux-spec",
    });
    expect(building.models).toEqual(["faux/faux-1"]);
    expect(unknown.models).toEqual(["faux/faux-1"]);
    expect(scratch.models).toEqual(["faux/faux-1"]);
    // The reply is the model's, not a refusal: the specifier's `echo` is a read and it ran.
    expect(specifying.entries.at(-1)?.text).toContain("faux-ok");
  });

  it("offers a read-only role no tool that writes, and a building role every tool", async () => {
    const specifying = await runIn(run("specifying", "specifier"));
    const building = await runIn(run("building", "builder"));

    expect(specifying.offered).toContain("read");
    expect(specifying.offered).toContain("bash");
    for (const tool of STAGE_REFUSED_TOOLS) {
      expect(specifying.offered).not.toContain(tool);
      expect(building.offered).toContain(tool);
    }
    // The filter is the role's, not the model's: with no role table the specifier is still
    // offered no write tool, and still runs the deployment's model.
    const untabled = await runIn(run("specifying", "specifier"), {
      roles: NO_ROLE_MODELS,
    });
    expect(untabled.models).toEqual(["faux/faux-1"]);
    expect(untabled.offered).not.toContain("write");
  });

  it("answers a read-only role's call to a withheld tool as unavailable, and writes nothing", async () => {
    const ran = await runIn(run("specifying", "specifier"), {
      model: callsWriteOnce("spec.md"),
      roles: NO_ROLE_MODELS,
    });

    const result = ran.entries.find((entry) => entry.kind === "toolResult");
    expect(result?.isError).toBe(true);
    expect(result?.text).toContain("Tool write is not available");
    expect(existsSync(join(ran.cwd, "spec.md"))).toBe(false);

    // The same model in a building run writes the file: the refusal is the role's filter.
    const building = await runIn(run("building", "builder"), {
      model: callsWriteOnce("spec.md"),
      roles: NO_ROLE_MODELS,
    });
    expect(
      building.entries.find((entry) => entry.kind === "toolResult")?.isError,
    ).toBe(false);
    expect(existsSync(join(building.cwd, "spec.md"))).toBe(true);
  });
});

/** The same log, opened again by a later owner: `close` is the harness's, the log outlives it. */
const sharedLog = (storage: MemoryStorage): Storage =>
  new Proxy(storage, {
    get: (target, key) => {
      if (key === "close") return () => Promise.resolve();
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

/**
 * A deployment whose two models have different windows, so a compaction policy derived from the
 * wrong one is visible: `faux-1` keeps pi-ai's default, `faux-small` has 8k. Every answer is `done`.
 */
const windowed = (): ModelAccess => {
  const models = createModels();
  const faux = fauxProvider({
    models: [{ id: "faux-1" }, { id: "faux-small", contextWindow: 8192 }],
  });
  models.setProvider(faux.provider);
  const step: FauxResponseFactory = () => {
    faux.appendResponses([step]);
    return fauxAssistantMessage("done");
  };
  faux.setResponses([step]);
  return {
    backend: "faux",
    models,
    provider: "faux",
    modelId: "faux-1",
    contextWindow: faux.models[0].contextWindow,
  };
};

describe("a reopened run", () => {
  it("keeps the model its root was pinned to, and that model's window, whatever the table says now", async () => {
    const access = windowed();
    const small = modelAccessFor(access, "faux/faux-small");
    if (small === undefined) throw new Error("the catalog serves faux-small");
    const log = new MemoryStorage();
    const cwd = mkdtempSync(join(tmpdir(), "factory-roles-reopen-"));
    const profile = run("specifying", "specifier");

    const turn = (table: RoleModels) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const opened = yield* openSession({
            storage: sharedLog(log),
            model: access,
            roles: table,
            cwd,
            run: profile,
          });
          const submitted = yield* submitMessage(opened.root, {
            content: "go",
          });
          yield* Effect.promise(() => submitted.submission.wait(context));
          const pinned = yield* Effect.promise(() =>
            opened.root.agent(context),
          );
          yield* closeHarness(opened.harness);
          return { model: opened.model, pinned: pinned.model };
        }),
      );

    // The first open creates the root on the role's row.
    const first = await turn(new Map([["specifier", small]]));
    expect(modelKey(first.model)).toBe("faux/faux-small");
    expect(first.model.contextWindow).toBe(8192);

    // The row is gone by the time the run is reopened: the root still talks to faux-small, and the
    // compaction thresholds are derived from faux-small's 8k, not from faux-1's window.
    const second = await turn(NO_ROLE_MODELS);
    expect(second.pinned).toEqual({ provider: "faux", modelId: "faux-small" });
    expect(modelKey(second.model)).toBe("faux/faux-small");
    expect(second.model.contextWindow).toBe(8192);
    expect(access.contextWindow).not.toBe(8192);

    // Every request of both turns went to faux-small, as the run's own usage says.
    const read = await Effect.runPromise(readSessionLog(log));
    expect(read.usage.models.map((entry) => entry.key)).toEqual([
      "faux/faux-small",
    ]);
  });
});

/**
 * A session created on a model (LOB-274): `openSession`'s `sessionModel` pins the root ahead of the
 * role's row and the deployment's model, and only on the open that creates the root. The pin is read
 * back from the conversation itself (`root.agent`, Pi Durable's `pi.agent`), not from what
 * `openSession` says it chose.
 */
describe("a session's own model", () => {
  /** Open a root on `options`, read what it is pinned to, and close it without sending anything. */
  const pinnedBy = (options: {
    readonly model: ModelAccess;
    readonly sessionModel?: ModelAccess;
    readonly roles?: RoleModels;
    readonly run?: RunProfile;
    readonly storage?: Storage;
  }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const opened = yield* openSession({
          storage: options.storage ?? new MemoryStorage(),
          model: options.model,
          ...(options.roles === undefined ? {} : { roles: options.roles }),
          ...(options.sessionModel === undefined
            ? {}
            : { sessionModel: options.sessionModel }),
          ...(options.run === undefined ? {} : { run: options.run }),
          cwd: mkdtempSync(join(tmpdir(), "factory-session-model-")),
        });
        const agent = yield* Effect.promise(() => opened.root.agent(context));
        yield* closeHarness(opened.harness);
        return { pinned: agent.model, model: modelKey(opened.model) };
      }),
    );

  it("pins anthropic/claude-haiku-4-5 into the root of a session created on it", async () => {
    // The real Anthropic catalog, with no credential: opening a root sends no request.
    const anthropic = createModelAccess("anthropic", {
      authContext: {
        env: async () => undefined,
        fileExists: async () => false,
      },
    });
    const haiku = modelAccessFor(anthropic, "anthropic/claude-haiku-4-5");
    if (haiku === undefined)
      throw new Error("pi-ai's catalog serves claude-haiku-4-5");

    const chosen = await pinnedBy({ model: anthropic, sessionModel: haiku });
    expect(chosen.pinned).toEqual({
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
    });
    expect(chosen.model).toBe("anthropic/claude-haiku-4-5");

    // Without one, the same deployment pins its own model: the pin above is the session's choice.
    const unchosen = await pinnedBy({ model: anthropic });
    expect(unchosen.pinned).toEqual({
      provider: "anthropic",
      modelId: DEFAULT_ANTHROPIC_MODEL,
    });
  });

  it("wins over the column's role row, and runs every request of the run on it", async () => {
    const access = createFauxModelAccess({
      fauxModels: ["faux-1", "faux-spec", "faux-pick"],
    }).access;
    const pick = modelAccessFor(access, "faux/faux-pick");
    const spec = modelAccessFor(access, "faux/faux-spec");
    if (pick === undefined || spec === undefined)
      throw new Error("the catalog serves both");
    const table: RoleModels = new Map([["specifier", spec]]);

    const chosen = await pinnedBy({
      model: access,
      roles: table,
      run: run("specifying", "specifier"),
      sessionModel: pick,
    });
    expect(chosen.pinned).toEqual({ provider: "faux", modelId: "faux-pick" });
    // The same run with no model of its own takes the role's row, as before.
    const role = await pinnedBy({
      model: access,
      roles: table,
      run: run("specifying", "specifier"),
    });
    expect(role.pinned).toEqual({ provider: "faux", modelId: "faux-spec" });

    // A whole turn: the faux model answers, and the run's usage is billed to the session's model.
    const ran = await runIn(run("specifying", "specifier"), {
      model: access,
      roles: table,
      sessionModel: pick,
    });
    expect(ran.status).toBe("done");
    expect(ran.models).toEqual(["faux/faux-pick"]);
  });

  it("decides only the open that creates the root: a reopen keeps the model it was pinned to", async () => {
    const access = createFauxModelAccess({
      fauxModels: ["faux-1", "faux-pick"],
    }).access;
    const pick = modelAccessFor(access, "faux/faux-pick");
    if (pick === undefined) throw new Error("the catalog serves faux-pick");
    const log = new MemoryStorage();

    const first = await pinnedBy({
      model: access,
      sessionModel: pick,
      storage: sharedLog(log),
    });
    expect(first.pinned).toEqual({ provider: "faux", modelId: "faux-pick" });
    // A later owner opens with no session model (the control plane passes it only at create).
    const reopened = await pinnedBy({ model: access, storage: sharedLog(log) });
    expect(reopened.pinned).toEqual({ provider: "faux", modelId: "faux-pick" });
    expect(reopened.model).toBe("faux/faux-pick");
  });
});
