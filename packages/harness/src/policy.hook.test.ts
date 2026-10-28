/**
 * The refusal, through a real harness (docs/design.md D11, D15).
 *
 * `policy.test.ts` proves the decision; this proves the decision is *delivered*: a real `Harness`
 * over a real `Storage`, the `policy` extension installed beside `CodingTools`, a real `ToolTask`
 * resolving the tool and running the hook, and the refusal arriving in the transcript as a result
 * the model reads. The side effect is asserted too — a blocked call that still wrote the file would
 * pass a test that only read the transcript.
 *
 * No database and no model: the storage is Pi Durable's in-memory implementation and the model is
 * the scripted faux provider, so this runs in the default gate.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { ModelAccess } from "./models";
import { autonomyPolicy, DEFAULT_AUTONOMY } from "./policy";
import { projectView } from "./projection";
import { closeHarness, openSession, submitMessage } from "./session";
import type { RunProfile } from "./loader";
import type { TranscriptEntry } from "@repo/domain/Session";

/** The session worktree, and a directory outside it that a refused write must not reach. */
const worktree = mkdtempSync(join(tmpdir(), "factory-policy-work-"));
const outside = mkdtempSync(join(tmpdir(), "factory-policy-outside-"));

/** The policy this file drives: D11's rules, resolved for the worktree above. */
const policy = autonomyPolicy(DEFAULT_AUTONOMY, worktree);

/**
 * A model that calls the tools it was given, one per turn, and then answers. The faux provider is
 * the same one `MODEL_BACKEND=faux` selects, so this drives the real tool path with no key and no
 * network.
 */
const scripted = (
  calls: readonly {
    readonly name: string;
    readonly args: Record<string, unknown>;
  }[],
): ModelAccess => {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  let index = 0;
  const step: FauxResponseFactory = () => {
    faux.appendResponses([step]);
    const next = calls[index];
    index += 1;
    return next === undefined
      ? fauxAssistantMessage("done")
      : fauxAssistantMessage(
          fauxToolCall(
            next.name,
            next.args as Parameters<typeof fauxToolCall>[1],
          ),
          { stopReason: "toolUse" },
        );
  };
  faux.setResponses([step]);
  return {
    backend: "faux",
    models,
    provider: "faux",
    modelId: faux.models[0].id,
    // This file's script answers every turn, so nothing here depends on a compaction threshold.
    contextWindow: faux.models[0].contextWindow,
  };
};

/**
 * The run profile of a documentation run: a column whose skills include the factory's `docs` skill
 * (LOB-225 seeds the row; LOB-195 makes a run holding it write documentation only).
 */
const DOCS_RUN: RunProfile = {
  column: "documenting",
  skills: [{ name: "docs", version: 1, body: "# Docs\n\nEdit documentation." }],
};

/**
 * The run profile of a column that holds no `docs` skill, so `openSession` installs the autonomy
 * policy alone. Its one skill is a stage skill, which no write rule reads.
 */
const CODE_RUN: RunProfile = {
  column: "implementing",
  skills: [
    { name: "implement", version: 1, body: "# Implement\n\nWrite code." },
  ],
};

/** Run one session to idle and return its transcript. */
const transcript = async (
  calls: readonly {
    readonly name: string;
    readonly args: Record<string, unknown>;
  }[],
  /**
   * Open the session with no policy at all, so `openSession`'s own default is what polices it
   * (docs/design.md D11: an unpoliced session must not be reachable by forgetting an argument).
   */
  defaultPolicy = false,
  /** The run's column and skills; absent for a session with no card. */
  run?: RunProfile,
): Promise<readonly TranscriptEntry[]> => {
  const storage = new MemoryStorage();
  const { harness, root } = await Effect.runPromise(
    openSession({
      storage,
      model: scripted(calls),
      cwd: worktree,
      ...(defaultPolicy ? {} : { policy }),
      ...(run === undefined ? {} : { run }),
    }),
  );
  const submitted = await Effect.runPromise(
    submitMessage(root, { content: "go", requestId: "policy" }),
  );
  const settled = await submitted.submission.wait(BACKGROUND_CONTEXT);
  expect(settled.status).toBe("done");
  const view = await root.viewState(BACKGROUND_CONTEXT);
  const projection = projectView(view.value);
  view.dispose();
  await Effect.runPromise(closeHarness(harness));
  return projection.entries;
};

const toolResults = (
  entries: readonly TranscriptEntry[],
): readonly TranscriptEntry[] =>
  entries.filter((entry) => entry.kind === "toolResult");

describe("the policy hook in a real harness", () => {
  it("refuses a write outside the worktree, and does not write it", async () => {
    const target = join(outside, "escaped.txt");
    const entries = await transcript([
      { name: "write", args: { path: target, content: "pwned" } },
    ]);

    const result = toolResults(entries)[0];
    expect(result?.isError).toBe(true);
    expect(result?.text).toContain("Tool call blocked");
    expect(result?.text).toContain("is refused");
    // The message names the worktree, so the model's next attempt can be the right one.
    expect(result?.text).toContain(worktree);
    expect(existsSync(target)).toBe(false);
  });

  it("refuses a bash command that writes outside the worktree, and does not run it", async () => {
    const target = join(outside, "escaped-by-shell.txt");
    const entries = await transcript([
      { name: "bash", args: { command: `echo pwned > ${target}` } },
    ]);

    const result = toolResults(entries)[0];
    expect(result?.isError).toBe(true);
    expect(result?.text).toContain("Tool call blocked");
    expect(existsSync(target)).toBe(false);
  });

  it("refuses a push to main, with a reason that names the ref", async () => {
    const entries = await transcript([
      { name: "bash", args: { command: "git push origin main" } },
    ]);

    const result = toolResults(entries)[0];
    expect(result?.isError).toBe(true);
    expect(result?.text).toContain("pushing refs/heads/main is refused");
  });

  it("refuses it even when the session was opened without a policy", async () => {
    // `openSession` resolves `DEFAULT_AUTONOMY` for its cwd when no policy is given, so an
    // unpoliced session is not something a caller can reach by forgetting an argument. The write
    // row is what proves the worktree the default resolved is the session's own cwd: the refusal
    // names it.
    const entries = await transcript(
      [
        { name: "bash", args: { command: "git push origin main" } },
        {
          name: "write",
          args: { path: join(outside, "escaped.txt"), content: "pwned" },
        },
      ],
      true,
    );

    const results = toolResults(entries);
    expect(results[0]?.isError).toBe(true);
    expect(results[0]?.text).toContain("pushing refs/heads/main is refused");
    expect(results[1]?.isError).toBe(true);
    expect(results[1]?.text).toContain(worktree);
    expect(existsSync(join(outside, "escaped.txt"))).toBe(false);
  });

  it("lets the happy path through untouched", async () => {
    const entries = await transcript([
      { name: "write", args: { path: "notes.txt", content: "hello" } },
      { name: "bash", args: { command: "echo faux-ok" } },
    ]);

    const results = toolResults(entries);
    expect(results.map((entry) => entry.isError)).toEqual([false, false]);
    expect(results[0]?.text).toContain("notes.txt");
    expect(results[1]?.text).toContain("faux-ok");
    // The tool really ran: the file is there.
    expect(readFileSync(join(worktree, "notes.txt"), "utf8")).toBe("hello");
  });
});

/**
 * The docs rule through the install site (LOB-195). Nothing here builds a policy: the session is
 * opened the way the control plane opens it — a run profile and, optionally, a policy — and the
 * session setup differs between the cases only in the column's skills. So what these rows prove is
 * the selection in `openSession`, not a flag a test set for itself.
 */
describe("a run holding the docs skill writes documentation only", () => {
  it("allows a write to a documentation file, and writes it", async () => {
    mkdirSync(join(worktree, "docs"), { recursive: true });
    const entries = await transcript(
      [{ name: "write", args: { path: "docs/design.md", content: "docs" } }],
      false,
      DOCS_RUN,
    );

    const result = toolResults(entries)[0];
    expect(result?.isError).toBe(false);
    expect(readFileSync(join(worktree, "docs/design.md"), "utf8")).toBe("docs");
  });

  it("refuses a write to a code file, naming the docs rule and the allowlist", async () => {
    const entries = await transcript(
      [
        {
          name: "write",
          args: { path: "packages/core/src/x.ts", content: "export {};" },
        },
      ],
      false,
      DOCS_RUN,
    );

    const result = toolResults(entries)[0];
    expect(result?.isError).toBe(true);
    expect(result?.text).toContain("Tool call blocked");
    // The docs rule fired, not the worktree rule: the path is inside the worktree.
    expect(result?.text).toContain("is refused by the docs rule");
    expect(result?.text).toContain("docs/**");
    expect(result?.text).not.toContain("only write inside its worktree");
    expect(existsSync(join(worktree, "packages/core/src/x.ts"))).toBe(false);
  });

  it("still refuses a write outside the worktree as that", async () => {
    const target = join(outside, "docs-run-escape.md");
    const entries = await transcript(
      [{ name: "write", args: { path: target, content: "pwned" } }],
      false,
      DOCS_RUN,
    );

    const result = toolResults(entries)[0];
    expect(result?.isError).toBe(true);
    expect(result?.text).toContain("only write inside its worktree");
    expect(result?.text).toContain(worktree);
    expect(result?.text).not.toContain("docs rule");
    expect(existsSync(target)).toBe(false);
  });

  it("allows the same code write in a run whose column holds no docs skill", async () => {
    mkdirSync(join(worktree, "packages/core/src"), { recursive: true });
    const entries = await transcript(
      [
        {
          name: "write",
          args: { path: "packages/core/src/allowed.ts", content: "ok" },
        },
      ],
      false,
      CODE_RUN,
    );

    const result = toolResults(entries)[0];
    expect(result?.isError).toBe(false);
    expect(
      readFileSync(join(worktree, "packages/core/src/allowed.ts"), "utf8"),
    ).toBe("ok");
  });
});

/**
 * A column's declared write scope through the install site (C22). The columns hold no `docs` skill
 * and declare no read-only role: the only thing that narrows them is `autonomy.write`, so a refusal
 * here is the declaration reaching `openSession` (through `columnWriteScope`, the function the
 * settings view describes the column with), not the skill or the role.
 */
describe("a column that declares its write scope is held to it", () => {
  const DECLARED_DOCS_RUN: RunProfile = {
    column: "careful",
    skills: [
      { name: "implement", version: 1, body: "# Implement\n\nWrite code." },
    ],
    autonomy: { write: "docs" },
  };
  const DECLARED_NONE_RUN: RunProfile = {
    column: "looking",
    role: "builder",
    skills: [],
    autonomy: { write: "none" },
  };

  it("refuses a code write in a column that declares write: docs, and allows a docs write", async () => {
    mkdirSync(join(worktree, "docs"), { recursive: true });
    const entries = await transcript(
      [
        {
          name: "write",
          args: { path: "src/declared-docs.ts", content: "export {};" },
        },
        { name: "write", args: { path: "docs/declared.md", content: "docs" } },
      ],
      false,
      DECLARED_DOCS_RUN,
    );

    const results = toolResults(entries);
    expect(results.map((entry) => entry.isError)).toEqual([true, false]);
    expect(results[0]?.text).toContain("is refused by the docs rule");
    expect(existsSync(join(worktree, "src/declared-docs.ts"))).toBe(false);
    expect(readFileSync(join(worktree, "docs/declared.md"), "utf8")).toBe(
      "docs",
    );
  });

  it("refuses a shell write in a column that declares write: none, naming the column as the stage", async () => {
    const entries = await transcript(
      [
        { name: "bash", args: { command: "echo x > declared-none.txt" } },
        { name: "write", args: { path: "declared-none.md", content: "x" } },
      ],
      false,
      DECLARED_NONE_RUN,
    );

    const results = toolResults(entries);
    expect(results.map((entry) => entry.isError)).toEqual([true, true]);
    expect(results[0]?.text).toContain("Tool call blocked");
    expect(results[0]?.text).toContain('column "looking"');
    // Not offered at all: a declared `none` is a read-only stage, like a specifier's.
    expect(results[1]?.text).toContain("Tool write is not available");
    expect(existsSync(join(worktree, "declared-none.txt"))).toBe(false);
    expect(existsSync(join(worktree, "declared-none.md"))).toBe(false);
  });
});

/**
 * The read-only stage through the install site (LOB-74). As with the docs rule, nothing here builds
 * a policy: the run profile is what `SessionService` hands `openSession` — the column the run
 * started in and the role it declares — and the two cases differ only in that profile. So the
 * refusal in one and the landed write in the other are the selection in `openSession`, and the
 * refusal is read out of the session's log.
 *
 * Since LOB-207 the stage is not *offered* `write`, `edit` or `verify` at all (the role's tool
 * filter, `./loader`'s `resolveRole`), so a model that calls one anyway is answered by Pi Durable's
 * `tool_unavailable` before any hook runs. The hook is what a `bash` write meets, and what a
 * `write` or an `edit` meets on a root whose tool list still offers them (the last case here).
 */
describe("a run in the specifying stage writes nothing", () => {
  const SPECIFYING_RUN: RunProfile = {
    column: "specifying",
    role: "specifier",
    skills: [
      { name: "specify", version: 1, body: "# Specify\n\nWrite the spec." },
    ],
  };
  const BUILDING_RUN: RunProfile = {
    column: "building",
    role: "builder",
    skills: [
      { name: "implement", version: 1, body: "# Implement\n\nWrite code." },
    ],
  };

  it("does not give specifying the write tool, and lets the same call write in building", async () => {
    const path = "stage-spec.md";
    const calls = [{ name: "write", args: { path, content: "spec" } }];

    const specifying = toolResults(
      await transcript(calls, false, SPECIFYING_RUN),
    );
    expect(specifying[0]?.isError).toBe(true);
    expect(specifying[0]?.text).toContain("Tool write is not available");
    expect(existsSync(join(worktree, path))).toBe(false);

    const building = toolResults(await transcript(calls, false, BUILDING_RUN));
    expect(building[0]?.isError).toBe(false);
    expect(readFileSync(join(worktree, path), "utf8")).toBe("spec");
  });

  it("has no edit tool, refuses a shell write naming the stage, and still runs a shell read", async () => {
    mkdirSync(join(worktree, "src"), { recursive: true });
    writeFileSync(join(worktree, "src/stage.ts"), "export const a = 1;\n");
    const entries = await transcript(
      [
        {
          name: "edit",
          args: {
            path: "src/stage.ts",
            edits: [{ oldText: "a = 1", newText: "a = 2" }],
          },
        },
        { name: "bash", args: { command: "echo x > stage-shell.txt" } },
        { name: "bash", args: { command: "cat src/stage.ts" } },
      ],
      false,
      SPECIFYING_RUN,
    );

    const results = toolResults(entries);
    expect(results.map((entry) => entry.isError)).toEqual([true, true, false]);
    expect(results[0]?.text).toContain("Tool edit is not available");
    expect(results[1]?.text).toContain("Tool call blocked");
    expect(results[1]?.text).toContain(
      "redirecting output to stage-shell.txt is refused",
    );
    expect(results[1]?.text).toContain("read-only specifying stage");
    expect(results[1]?.text).toContain('column "specifying"');
    expect(results[2]?.text).toContain("export const a = 1;");
    expect(readFileSync(join(worktree, "src/stage.ts"), "utf8")).toBe(
      "export const a = 1;\n",
    );
    expect(existsSync(join(worktree, "stage-shell.txt"))).toBe(false);
  });

  /**
   * The filter is pinned with the root, so a root that still offers every tool — one created before
   * the filter existed, a run in flight across the deploy that brought it, or one whose tool list
   * was configured since — reaches the stage's hook with a `write` or an `edit`. That is the hook's
   * own refusal, end to end, in the stage's words.
   */
  it("refuses write and edit by the stage's own rule on a root that still offers them", async () => {
    mkdirSync(join(worktree, "src"), { recursive: true });
    writeFileSync(join(worktree, "src/pinned.ts"), "export const b = 1;\n");
    const path = "stage-pinned.md";
    const storage = new MemoryStorage();
    const { harness, root } = await Effect.runPromise(
      openSession({
        storage,
        model: scripted([
          { name: "write", args: { path, content: "spec" } },
          {
            name: "edit",
            args: {
              path: "src/pinned.ts",
              edits: [{ oldText: "b = 1", newText: "b = 2" }],
            },
          },
        ]),
        cwd: worktree,
        policy,
        run: SPECIFYING_RUN,
      }),
    );
    // What a root pinned without the filter holds: every tool, which `tools: null` restores.
    await root.configure({ tools: null }, BACKGROUND_CONTEXT);
    const submitted = await Effect.runPromise(
      submitMessage(root, { content: "go", requestId: "pinned" }),
    );
    expect((await submitted.submission.wait(BACKGROUND_CONTEXT)).status).toBe(
      "done",
    );
    const view = await root.viewState(BACKGROUND_CONTEXT);
    const results = toolResults(projectView(view.value).entries);
    view.dispose();
    await Effect.runPromise(closeHarness(harness));

    expect(results.map((entry) => entry.isError)).toEqual([true, true]);
    expect(results[0]?.text).toContain("Tool call blocked");
    expect(results[0]?.text).toContain(`write ${path} is refused`);
    expect(results[0]?.text).toContain("read-only specifying stage");
    expect(results[0]?.text).toContain('column "specifying"');
    expect(results[1]?.text).toContain("edit src/pinned.ts is refused");
    expect(existsSync(join(worktree, path))).toBe(false);
    expect(readFileSync(join(worktree, "src/pinned.ts"), "utf8")).toBe(
      "export const b = 1;\n",
    );
  });
});
