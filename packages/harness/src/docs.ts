/**
 * Typed session documents: state that is not the transcript, committed atomically with it
 * (LOB-23). Each is a `defineDoc` token so reads and writes go through the typed surface
 * instead of raw string kinds.
 */
import { defineDoc } from "@earendil-works/pi-durable";

export const SPEC_DOC_KIND = "factory.spec";
export const CRITERIA_DOC_KIND = "factory.criteria";
export const PR_URL_DOC_KIND = "factory.prUrl";
export const RETRY_DOC_KIND = "factory.retry";

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

export const PrUrlDoc = defineDoc({
  kind: PR_URL_DOC_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ prUrl: "" }),
});

export const RetryDoc = defineDoc({
  kind: RETRY_DOC_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ count: 0 }),
});
