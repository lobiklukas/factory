/**
 * The curator pass (LOB-206, part 3 of LOB-47).
 *
 * The claims worth proving here are about the *bounds*, not the prose: one request, at most
 * `maxPages` proposals, and a spend charged to the session that was curated. The request count is
 * read from the provider's own counter (`faux.state.callCount`) rather than from the pass's own
 * answer, so a regression that opens a second call fails this file even if it reports one.
 *
 * No database and no network: the log is Pi Durable's in-memory storage and the model is the
 * scripted faux provider, so this runs in the default gate.
 */
import { MemoryStorage } from "@earendil-works/pi-durable";
import type { Usage } from "@earendil-works/pi-ai";
import type { SessionUsage, TranscriptEntry } from "@repo/domain/Session";
import { Effect, Exit, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  clampCurationPages,
  curationProposals,
  curationPrompt,
  requestCuration,
  DEFAULT_CURATION_PAGES,
  MAX_CURATION_PAGES,
  writeCurationUsage,
  type CurationOptions,
} from "./curate";
import { createFauxModelAccess, modelKey } from "./models";
import { closeHarness, openSession, readSessionLog } from "./session";

/** A session id nobody owns, so a citation is a string and not a lookup. */
const sourceId = "ses_00000000000000000000000000";

/** One transcript entry as the projection would hand it over. */
const entry = (
  id: string,
  kind: TranscriptEntry["kind"],
  text: string,
  toolName?: string,
): TranscriptEntry => ({
  id,
  kind,
  text,
  toolCalls: [],
  ...(toolName === undefined ? {} : { toolName }),
});

/**
 * One curation as the service drives it: the call, then the proposals, with the call's spend in hand
 * — so a case can assert the spend a caller is expected to charge before it reads the answer.
 */
const curate = (options: CurationOptions) =>
  Effect.gen(function* () {
    const request = yield* requestCuration(options);
    const curation = yield* curationProposals(request, options);
    return { ...curation, usage: request.usage };
  });

/** A curation answer proposing `count` pages, as a model would write it. */
const proposing = (count: number): string =>
  JSON.stringify(
    Array.from({ length: count }, (_, index) => ({
      name: `page-${index}`,
      kind: "trap",
      content: `the ${index}th thing the session taught`,
      links: [],
      sources: [],
    })),
  );

/** What one curation call would have cost, if the provider had priced it. */
const callUsage: Usage = {
  input: 10,
  output: 5,
  cacheRead: 1,
  cacheWrite: 2,
  totalTokens: 18,
  cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
};

describe("clampCurationPages", () => {
  it("defaults, clamps and floors the cap", () => {
    expect(clampCurationPages(undefined)).toBe(DEFAULT_CURATION_PAGES);
    expect(clampCurationPages(2)).toBe(2);
    expect(clampCurationPages(0)).toBe(1);
    expect(clampCurationPages(-5)).toBe(1);
    expect(clampCurationPages(999)).toBe(MAX_CURATION_PAGES);
    expect(clampCurationPages(2.7)).toBe(2);
  });
});

describe("one curation is one call", () => {
  it("writes at most maxPages of what the model proposed, in one request", async () => {
    const faux = createFauxModelAccess({ fauxCuration: proposing(5) });
    const curation = await Effect.runPromise(
      curate({
        model: faux.access,
        sourceId,
        entries: [entry("1", "toolResult", "faux-ok", "bash")],
        pages: [],
        maxPages: 2,
      }),
    );

    expect(curation.proposals.map((page) => page.name)).toEqual([
      "page-0",
      "page-1",
    ]);
    // The cap did work, and says so: five were proposed, two were kept.
    expect(curation.proposed).toBe(5);
    // Every page a curator proposes cites the session it curated, whether or not the model did.
    for (const page of curation.proposals)
      expect(page.sources).toEqual([sourceId]);
    expect(faux.faux.state.callCount).toBe(1);
    expect(curation.usage.totalTokens).toBeGreaterThan(0);
  });

  it("proposes nothing, in one call, when the session ran no tool", async () => {
    // The derived answer, not a scripted one: a transcript with no tool result is a session that
    // taught nothing, and the faux says so rather than inventing a page.
    const faux = createFauxModelAccess();
    const curation = await Effect.runPromise(
      curate({
        model: faux.access,
        sourceId,
        entries: [
          entry("1", "user", "do the thing"),
          entry("2", "assistant", "I did nothing"),
        ],
        pages: [],
        maxPages: 3,
      }),
    );

    expect(curation.proposals).toEqual([]);
    expect(curation.proposed).toBe(0);
    expect(faux.faux.state.callCount).toBe(1);
  });

  it("proposes one page per tool the transcript shows, from the derived answer", async () => {
    const faux = createFauxModelAccess();
    const curation = await Effect.runPromise(
      curate({
        model: faux.access,
        sourceId,
        entries: [
          entry("1", "toolResult", "faux-ok", "bash"),
          entry("2", "toolResult", "read me", "read"),
        ],
        pages: [],
        maxPages: 3,
      }),
    );

    expect(curation.proposals.map((page) => page.name)).toEqual([
      "bash-ran",
      "read-ran",
    ]);
    expect(faux.faux.state.callCount).toBe(1);
  });

  it("refuses an answer it cannot read instead of writing nothing", async () => {
    const faux = createFauxModelAccess({
      fauxCuration: "I believe the session taught one useful thing.",
    });
    const outcome = await Effect.runPromise(
      Effect.exit(
        curate({
          model: faux.access,
          sourceId,
          entries: [entry("1", "toolResult", "faux-ok", "bash")],
          pages: [],
          maxPages: 3,
        }),
      ),
    );

    const failure = Exit.findErrorOption(outcome);
    expect(Option.isSome(failure)).toBe(true);
    const error = Option.getOrThrow(failure);
    expect(error._tag).toBe("SessionError");
    expect(error.message).toContain("no JSON array");
    // A failed answer is still one call: the pass does not retry its way to a parsable one.
    expect(faux.faux.state.callCount).toBe(1);
  });
});

describe("the prompt the curator is given", () => {
  it("names the pages the session already holds and keeps only the newest transcript", () => {
    // Entries long enough that forty of them cannot fit the budget: the case is about what falls
    // out of the prompt, so the transcript has to be bigger than it.
    const entries = Array.from({ length: 40 }, (_, index) =>
      entry(
        `${index}`,
        "user",
        index === 0 ? "the oldest thing" : `entry ${index} ${"x".repeat(400)}`,
      ),
    );
    const prompt = curationPrompt({
      sourceId,
      entries,
      pages: [
        {
          name: "a-trap",
          kind: "trap",
          content: "the batch delete",
          links: [],
          sources: [],
        },
      ],
      maxPages: 4,
    });

    expect(prompt.startsWith("<curate>")).toBe(true);
    expect(prompt).toContain("- a-trap [trap]: the batch delete");
    expect(prompt).toContain("entry 39 x");
    // The budget is what bounds the request, so the head of a long transcript is what falls out.
    expect(prompt).not.toContain("the oldest thing");
    expect(prompt.length).toBeLessThan(12_000);
    expect(prompt).toContain("at most 4 pages");
  });

  it("bounds the pages it reads as context, and says what it left out", () => {
    const pages = Array.from({ length: 12 }, (_, index) => ({
      name: `page-${index}`,
      kind: "trap",
      content: "y".repeat(400),
      links: [],
      sources: [],
    }));
    const prompt = curationPrompt({
      sourceId,
      entries: [],
      pages,
      maxPages: 3,
    });
    // A session curated many times must not grow the prompt with every pass: the existing pages are
    // a budget too, and the ones that did not fit are counted rather than silently dropped.
    expect(prompt).toContain("more pages not shown");
    expect(prompt.length).toBeLessThan(6_000);
  });

  it("says the answer is JSON, and that nothing is a correct answer", () => {
    const prompt = curationPrompt({
      sourceId,
      entries: [],
      pages: [],
      maxPages: 1,
    });
    expect(prompt).toContain("(empty)");
    expect(prompt).toContain("(none)");
    expect(prompt).toContain(
      "An empty array means the session taught nothing new.",
    );
  });
});

describe("the spend is charged to the conversation it curated", () => {
  it("adds to the session's own usage ledger, field by field", async () => {
    const storage = new MemoryStorage();
    const usage = await Effect.runPromise(
      Effect.gen(function* () {
        const { harness, root } = yield* openSession({
          storage,
          model: createFauxModelAccess().access,
          cwd: process.cwd(),
        });
        yield* writeCurationUsage(root, "faux/faux-1", callUsage);
        const once = yield* readSessionLog(storage);
        yield* writeCurationUsage(root, "faux/faux-1", callUsage);
        const twice = yield* readSessionLog(storage);
        yield* closeHarness(harness);
        return { once: once.usage, twice: twice.usage };
      }),
    );

    const bucket = (
      state: SessionUsage,
    ): SessionUsage["models"][number]["usage"] | undefined =>
      state.models.find((model) => model.key === "faux/faux-1")?.usage;
    expect(bucket(usage.once)).toEqual({
      input: 10,
      output: 5,
      cacheRead: 1,
      cacheWrite: 2,
      totalTokens: 18,
      costTotal: 0.3,
    });
    // A second call adds to the bucket instead of replacing it: the ledger is cumulative, as a
    // turn's own `pi.usage` is.
    expect(bucket(usage.twice)?.totalTokens).toBe(36);
    expect(bucket(usage.twice)?.costTotal).toBeCloseTo(0.6);
  });

  it("charges the model the process serves, keyed the way pi-durable keys it", () => {
    const faux = createFauxModelAccess();
    expect(modelKey(faux.access)).toBe(`faux/${faux.access.modelId}`);
  });
});
