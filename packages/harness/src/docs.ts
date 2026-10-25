/**
 * Typed session documents: state that is not the transcript, committed atomically with it
 * (LOB-23). Each is a `defineDoc` token so reads and writes go through the typed surface
 * instead of raw string kinds.
 */
import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";

export const SPEC_DOC_KIND = "factory.spec";
export const CRITERIA_DOC_KIND = "factory.criteria";
export const PR_DOC_KIND = "factory.pr";
export const RETRY_DOC_KIND = "factory.retry";
export const PAGE_DOC_KIND = "factory.page";
export const MISSION_DOC_KIND = "factory.mission";

export const SpecDoc = defineDoc({
  kind: SPEC_DOC_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ spec: "" }),
});

export const CriteriaDoc = defineDoc({
  kind: CRITERIA_DOC_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ criteria: "" }),
});

export const PrDoc = defineDoc({
  kind: PR_DOC_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ url: "", number: 0, base: "", head: "", openedAt: "" }),
});

export const RetryDoc = defineDoc({
  kind: RETRY_DOC_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ count: 0 }),
});

/**
 * A cited knowledge page (LOB-204, part 1 of LOB-47), keyed by the page's name.
 *
 * A family rather than a singleton because a session teaches more than one page, and each page is
 * its own record: a later commit rewrites the member it names and leaves its siblings alone. The
 * seed is the key, so a member that has never been written reads as an empty page of that name
 * rather than as a page with no name.
 */
export const PageDoc = defineDocFamily({
  kind: PAGE_DOC_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  family: true,
  initial: (name: string) => ({
    name,
    kind: "",
    content: "",
    links: [] as string[],
    sources: [] as string[],
  }),
});

/**
 * The phase a mission reached (LOB-229), keyed by the mission's task id.
 *
 * A conversation family rather than one document per conversation, because a conversation holds more
 * than one mission: a single conversation-scoped document would interleave two missions' phases into
 * one list, and a mission that never ran would read the previous one's phase back as its own.
 *
 * A conversation family rather than a `scope: "task"` document, because Pi Durable retires every
 * task document when its task reaches a terminal state (`transaction.js`, "Terminal settlement
 * retires every task document"). The phase record is exactly what has to survive the mission
 * finishing: a reopen reads it after the mission is terminal, which is when a task document is gone.
 *
 * `phase` is the phase the mission is in, which is what a resume reads. `entered` is every phase it
 * has entered, in order, because a conversation document keeps only its latest value: without the
 * list the log would name the phase the mission stopped in and say nothing about how it got there.
 * Re-entering the phase the mission is already in appends nothing, so a resumed phase is one entry,
 * not two. `mission` is the key, so a member names the mission it belongs to.
 *
 * `definitionVersion` is the version of `mission.ts` that named the phase, because a stored checkpoint
 * is read back through the definition that wrote it.
 *
 * Empty `phase` is "this mission has not entered a phase yet", which is what the seed says; the seed
 * cannot say `plan`, because a mission that never ran never planned anything.
 */
export const MissionDoc = defineDocFamily({
  kind: MISSION_DOC_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  family: true,
  initial: (mission: string) => ({
    mission,
    phase: "",
    definitionVersion: 0,
    entered: [] as string[],
  }),
});
