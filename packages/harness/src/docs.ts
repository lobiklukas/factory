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
