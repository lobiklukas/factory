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
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
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
  skills: [{ name: "docs", body: "# Docs\n\nEdit documentation." }],
};

/**
 * The run profile of a column that holds no `docs` skill, so `openSession` installs the autonomy
 * policy alone. Its one skill is a stage skill, which no write rule reads.
 */
const CODE_RUN: RunProfile = {
  column: "implementing",
  skills: [{ name: "implement", body: "# Implement\n\nWrite code." }],
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
