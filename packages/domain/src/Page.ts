import { Schema } from "effect";
import { SessionId } from "@repo/domain/Session";

/**
 * A cited knowledge page (LOB-204, part 1 of LOB-47).
 *
 * A page is what a finished session taught the factory: a named, kinded note whose `links` point at
 * other pages and whose `sources` are the session ids it was learned from. The citations are
 * **data, not foreign keys** — a source session can be deleted, or never have existed, and the page
 * still reads back, because the point of a citation is the claim it backs, not the row it names.
 */
export const Page = Schema.Struct({
  /** The page's identity within its session: unique, and what a `factory.page` member is keyed by. */
  name: Schema.String,
  /** What sort of note it is (a decision, a trap, a guide): free text, owned by the writer. */
  kind: Schema.String,
  content: Schema.String,
  /** Names of pages this one points at. Not validated: a link may be written before its target. */
  links: Schema.Array(Schema.String),
  /** Session ids this page was learned from, as strings, with no reference implied. */
  sources: Schema.Array(Schema.String),
});
export type Page = typeof Page.Type;

/**
 * The two citation columns as JSON text: one codec, so the writer and the reader cannot drift. The
 * column is `jsonb` but is read and written as text, the way `skills.attachments` is.
 */
export const PageStrings = Schema.fromJsonString(Schema.Array(Schema.String));

/** Record (or replace) one page in a session's log and its index rows. */
export const RecordPageInput = Schema.Struct({
  sessionId: SessionId,
  name: Schema.String,
  kind: Schema.String,
  content: Schema.String,
  links: Schema.Array(Schema.String),
  sources: Schema.Array(Schema.String),
});
export type RecordPageInput = typeof RecordPageInput.Type;

export const ListPagesInput = Schema.Struct({ sessionId: SessionId });
export type ListPagesInput = typeof ListPagesInput.Type;

export const ListPagesOutput = Schema.Struct({ pages: Schema.Array(Page) });
export type ListPagesOutput = typeof ListPagesOutput.Type;

/**
 * Curate a completed session's pages (LOB-206, part 3 of LOB-47).
 *
 * One bounded model call over the session's transcript and the pages it already holds proposes page
 * writes; the server commits at most `maxPages` of them, and none of them when the session taught
 * nothing new. `maxPages` is clamped by the server rather than refused, as a list's page size is.
 */
export const CurateSessionInput = Schema.Struct({
  sessionId: SessionId,
  /** The most pages one curation writes. The server clamps it. */
  maxPages: Schema.optional(Schema.Int),
});
export type CurateSessionInput = typeof CurateSessionInput.Type;

/**
 * What one curation did: the pages it wrote, and how many the model proposed before the cap.
 *
 * `pages` empty with `proposed` zero is the honest "taught nothing new" answer, and it costs the
 * same one call as a curation that wrote: the pass is bounded by its call, not by its findings.
 */
export const CurateSessionResult = Schema.Struct({
  /** The pages this pass committed, in the order it committed them (by name when read back). */
  pages: Schema.Array(Page),
  /** What the model proposed, including the proposals the cap dropped and the ones it already held. */
  proposed: Schema.Int,
});
export type CurateSessionResult = typeof CurateSessionResult.Type;
