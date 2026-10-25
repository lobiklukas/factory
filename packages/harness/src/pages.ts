/**
 * The `pages` system-prompt section: the knowledge a session carries (LOB-205, part 2 of LOB-47).
 *
 * A page is what a finished session taught the factory (`@repo/domain/Page`, part 1). This module
 * is the one place that turns pages into prompt text, so "what a session was told" is a pure
 * function of the pages and the budget rather than of whatever order a query happened to return:
 *
 * - **It is capped, and the cap is measured with the estimator the compaction policy uses.**
 *   `estimateTextTokens` is the arithmetic behind `estimateMessageTokens`, which is what
 *   `estimateContext` (pi-durable's compaction measure) sums for every message it counts. A budget
 *   in any other unit would be a second, disagreeing notion of size beside the one that decides
 *   when a session compacts, which is why it is the same function rather than a character count.
 *
 * - **What did not fit is named, not silently missing.** `dropped` is the record: the section keeps
 *   what the budget allowed, and the caller commits the drop to the log (`PagesPromptDoc`), so
 *   "which pages did this run receive" is answerable after the fact instead of inferred.
 *
 * - **Which pages survive the cap is decided, not incidental.** Pages are admitted newest first (a
 *   page's newest source session; session ids are time-sortable, see `packages/core/src/ids.ts`),
 *   then shallowest in the link graph: a page nothing links to is depth 0, a page reachable only
 *   through a link cycle has no depth at all and goes last. So the peripheral notes go first and the
 *   hub notes stay, and two page sets with the same content always produce the same text.
 */
import type { Extension, PromptSection } from "@earendil-works/pi-durable";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { Page } from "@repo/domain/Page";

/** The section's key, and so its `<pages>` tag in the rendered prompt. */
export const PAGES_SECTION_KEY = "pages";

/** The extension the section is installed as, so a registry can be read back by name. */
export const PAGES_EXTENSION = "factory.pages";

/**
 * The token budget the section may spend.
 *
 * A few hundred tokens is a page or two of dense notes: enough that a session opens knowing the
 * repo's traps, small enough that it is never the reason a run compacts early. It is a constant
 * rather than configuration for now — nothing in the product decides a repo's budget yet — and it is
 * spent through the same estimator compaction uses, so its cost is comparable to the transcript's.
 */
export const PAGES_TOKEN_CAP = 512;

/** What one page set came to under the cap: the text, its measured cost, and what it left out. */
export type PagesPrompt = {
  /** The section's inner text, absent when no page fits (or there are no pages): no section at all. */
  readonly text?: string;
  /** The rendered section's size in tokens, tag included. `0` when nothing is rendered. */
  readonly tokens: number;
  /** The pages the section carries, in the order it carries them. */
  readonly included: readonly string[];
  /** The pages the budget left out, in the order they were ranked. */
  readonly dropped: readonly string[];
};

/** The tag Pi Durable renders around a section, so the budget measures what the model is sent. */
const sectionText = (inner: string): string =>
  `<${PAGES_SECTION_KEY}>\n${inner}\n</${PAGES_SECTION_KEY}>`;

/**
 * A page's recency: the newest session it cites.
 *
 * Session ids are Crockford base32 with a millisecond timestamp in front, so ordering them as text
 * orders them by time — and a page taught by a newer session is newer knowledge. A page that cites
 * nothing is the oldest there is, because nothing says when it was learned.
 */
const recencyOf = (page: Page): string => {
  let newest = "";
  for (const source of page.sources) if (source > newest) newest = source;
  return newest;
};

/**
 * How far each page sits from a root of the link graph.
 *
 * A root is a page no other page links to. Walking a page's links is walking away from its root, so
 * a page's depth is one more than the shallowest page linking to it. A page reachable only through
 * a cycle has no root above it and gets `Number.POSITIVE_INFINITY`: the graph says nothing about it,
 * so it goes last rather than pretending to be shallow.
 */
const depthsOf = (pages: readonly Page[]): ReadonlyMap<string, number> => {
  const names = new Set(pages.map((page) => page.name));
  const outgoing = new Map<string, readonly string[]>();
  const linked = new Set<string>();
  for (const page of pages) {
    // A link to a page this session does not hold is still a link: it names knowledge elsewhere,
    // and it cannot make the held page a root, so it is dropped from the walk but not ignored.
    const links = page.links.filter((link) => names.has(link));
    outgoing.set(page.name, links);
    for (const link of links) linked.add(link);
  }
  const depths = new Map<string, number>();
  const queue: string[] = [];
  for (const page of pages) {
    if (linked.has(page.name)) continue;
    depths.set(page.name, 0);
    queue.push(page.name);
  }
  while (queue.length > 0) {
    const name = queue.shift();
    if (name === undefined) break;
    const depth = depths.get(name) ?? 0;
    for (const link of outgoing.get(name) ?? []) {
      const known = depths.get(link);
      if (known !== undefined && known <= depth + 1) continue;
      depths.set(link, depth + 1);
      queue.push(link);
    }
  }
  return depths;
};

/** One page as prompt text: its name and kind, its content, and the citations it carries. */
const blockOf = (page: Page): string => {
  const kind = page.kind.trim();
  const lines = [
    `## ${page.name}${kind === "" ? "" : ` (${kind})`}`,
    page.content,
  ];
  if (page.links.length > 0) lines.push(`links: ${page.links.join(", ")}`);
  if (page.sources.length > 0)
    lines.push(`sources: ${page.sources.join(", ")}`);
  return lines.join("\n");
};

/** Newest first, then shallowest, then by name so the order is total and content-independent. */
const rank = (
  pages: readonly Page[],
  depths: ReadonlyMap<string, number>,
): readonly Page[] =>
  [...pages].sort((left, right) => {
    const recency = recencyOf(right).localeCompare(recencyOf(left));
    if (recency !== 0) return recency;
    const leftDepth = depths.get(left.name) ?? Number.POSITIVE_INFINITY;
    const rightDepth = depths.get(right.name) ?? Number.POSITIVE_INFINITY;
    if (leftDepth !== rightDepth) return leftDepth < rightDepth ? -1 : 1;
    return left.name.localeCompare(right.name);
  });

/**
 * Assemble the section from a page set under a token budget.
 *
 * Pages are admitted in rank order while the rendered section stays inside `cap`, and the cut is a
 * prefix: the first page that does not fit ends the section, and every page ranked after it is
 * dropped. So the drop really is "by recency first, then by link depth" — an older page never
 * displaces a newer one for being shorter — and the section is a prefix of the ranked list rather
 * than a subset chosen by size. The measure is of the whole rendered section, tag included, because
 * that is what the model is sent; a budget over the inner text would be a budget over less than the
 * cost.
 */
export const assemblePages = (
  pages: readonly Page[],
  cap: number = PAGES_TOKEN_CAP,
): PagesPrompt => {
  const included: string[] = [];
  const dropped: string[] = [];
  let inner = "";
  let full = false;
  for (const page of rank(pages, depthsOf(pages))) {
    if (full) {
      dropped.push(page.name);
      continue;
    }
    const block = blockOf(page);
    const candidate = inner === "" ? block : `${inner}\n\n${block}`;
    if (estimateTextTokens(sectionText(candidate)) > cap) {
      // The section is a prefix of the ranked pages: once one does not fit, nothing ranked after it
      // goes in, however small it is. Otherwise an old one-line note could cost a newer page its place.
      full = true;
      dropped.push(page.name);
      continue;
    }
    inner = candidate;
    included.push(page.name);
  }
  if (inner === "") {
    return { tokens: 0, included, dropped };
  }
  return {
    text: inner,
    tokens: estimateTextTokens(sectionText(inner)),
    included,
    dropped,
  };
};

/**
 * The section as an extension, installed at `openSession` like the column's skills.
 *
 * The prompt is assembled once, when the session opens, from the pages the control plane read at
 * that moment: a page curated during a run reaches the session's *next* open, which is the same
 * freshness the run's skill bodies have (B6) and the reason the read is not cached across runs.
 */
export const pagesExtension = (prompt: PagesPrompt): Extension => {
  const sections: PromptSection[] = [
    section(PAGES_SECTION_KEY, () => prompt.text),
  ];
  return defineExtension({ name: PAGES_EXTENSION, sections });
};
