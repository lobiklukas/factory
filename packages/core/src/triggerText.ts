/**
 * Injection hygiene for the text a trigger turns into a prompt (S-trigger-trust-gating).
 *
 * A delivery's title and body are a stranger's words until a person reads them, and the agent reads
 * them first. What a person reviewing the issue *cannot* see is the danger: a zero-width or
 * tag-character run that spells an instruction no renderer shows ("ASCII smuggling"), a bidi
 * override that makes the text read differently from how it runs, and an HTML comment, which Linear
 * and GitHub render as nothing. Copilot's cloud agent, Ona and Amp strip the same three before their
 * agent sees an issue; this is that pass, applied by the seam to every source's title and body and to
 * the rendered prompt, so no adapter can forget it.
 *
 * It is a pure function with a fixed order, so a unit test pins it:
 *
 * 1. **NFKC.** Compatibility forms fold into the letters they look like (full-width `ｒｍ` is `rm`),
 *    so what the agent reads is what a reviewer reads — and a full-width `＜！－－` becomes the `<!--`
 *    the comment pass then removes.
 * 2. **Hidden characters are removed** (`isHiddenCodePoint`): zero-width spaces and joiners, bidi
 *    embeddings, overrides, isolates and marks, Unicode tag characters, variation selectors, the
 *    invisible fillers and operators, the soft hyphen, the byte-order mark, and every C0/C1 control
 *    but tab, newline and carriage return. Removing a joiner splits an emoji sequence into its parts;
 *    that is the price of removing the one a smuggler uses.
 * 3. **Comments and invisible markup are removed**, until none is left — removing one must not
 *    join the pieces around it into another: closed HTML comments, processing instructions and
 *    declarations, and `[//]: # (…)` comment lines. Then an unterminated `<!--` is removed to the
 *    end of the text when raw HTML is read there (`removeComments`); in plain markdown it is
 *    literal text a reviewer sees, and stays.
 * 4. **NFKC again**, since a removed character may have separated a sequence that now composes.
 *
 * Nothing else is rewritten: markdown, code, newlines and every visible character stay as written. A
 * closed comment inside a code block is removed too: telling code from raw HTML exactly as GitHub
 * does is a parser this pass does not have, and removing a visible comment is the safe mistake.
 */

/** What `sanitizeTriggerText` took out, so a recorded reason can say so. */
export type SanitizedText = {
  readonly text: string;
  /** Hidden characters removed (`isHiddenCodePoint`). */
  readonly hidden: number;
  /** HTML comments removed, an unterminated one included. */
  readonly comments: number;
  /** Other markup a renderer shows as nothing: `<?…>`, `<!DOCTYPE …>`, a `[//]: # (…)` line. */
  readonly markup: number;
};

/** Inclusive code point ranges a renderer shows as nothing, or that reorder what it shows. */
const HIDDEN_RANGES: ReadonlyArray<readonly [number, number]> = [
  // C0 controls except tab (0x09), newline (0x0a) and carriage return (0x0d).
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  // DEL and the C1 controls.
  [0x7f, 0x9f],
  // Soft hyphen.
  [0xad, 0xad],
  // Combining grapheme joiner.
  [0x34f, 0x34f],
  // Arabic letter mark (a bidi mark).
  [0x61c, 0x61c],
  // Hangul choseong and jungseong fillers.
  [0x115f, 0x1160],
  // Khmer inherent vowels, which render as nothing.
  [0x17b4, 0x17b5],
  // Mongolian free variation selectors and vowel separator.
  [0x180b, 0x180f],
  // Zero-width space, non-joiner, joiner; left-to-right and right-to-left marks.
  [0x200b, 0x200f],
  // Bidi embeddings and overrides (LRE, RLE, PDF, LRO, RLO).
  [0x202a, 0x202e],
  // Word joiner, invisible operators, bidi isolates (LRI, RLI, FSI, PDI), deprecated format controls.
  [0x2060, 0x206f],
  // Hangul filler.
  [0x3164, 0x3164],
  // Variation selectors 1–16.
  [0xfe00, 0xfe0f],
  // Byte-order mark / zero-width no-break space.
  [0xfeff, 0xfeff],
  // Half-width Hangul filler.
  [0xffa0, 0xffa0],
  // Interlinear annotation anchors and separators.
  [0xfff9, 0xfffb],
  // Unicode tag characters: an invisible copy of ASCII, the smuggling channel.
  [0xe0000, 0xe007f],
  // Variation selectors 17–256.
  [0xe0100, 0xe01ef],
];

/** Whether a code point is one this pass removes. Exported so a test can name the set. */
export const isHiddenCodePoint = (codePoint: number): boolean =>
  HIDDEN_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high);

const removeHidden = (
  text: string,
): { readonly text: string; readonly hidden: number } => {
  let hidden = 0;
  let kept = "";
  for (const char of text) {
    if (isHiddenCodePoint(char.codePointAt(0) ?? 0)) hidden += 1;
    else kept += char;
  }
  return { text: kept, hidden };
};

/**
 * A closed HTML comment as CommonMark reads one: the empty `<!-->` and `<!--->`, or an opener and
 * the first `-->` after it. Removed wherever it stands — a reviewer sees one inside a code span, so
 * there this removes visible text, but a parser that tells code from raw HTML differently from
 * GitHub's would let a hidden one through, and over-removing is the safe side.
 */
const CLOSED_COMMENT = /<!--(?:>|->|[\s\S]*?-->)/g;

/**
 * The rest of what a renderer shows as nothing (`markup`):
 *
 * - a processing instruction, declaration or CDATA section as CommonMark reads one inline
 *   (`<?…?>`, `<!DOCTYPE …>`, `<![CDATA[…]]>`), which it passes through as raw HTML and a browser
 *   shows none of (an HTML parser reads each as a bogus comment). Only the closed forms: an
 *   unclosed `<?` is literal text in markdown, and removing to some later `>` would cut a body a
 *   reviewer reads whole;
 * - a link reference definition pointing at `#` or `<>` — the `[//]: # (…)` comment idiom — which
 *   markdown renders as nothing, on its own line (after any blockquote markers).
 */
const BOGUS_COMMENT =
  /<\?[\s\S]*?\?>|<![A-Za-z][^>]*>|<!\[CDATA\[[\s\S]*?\]\]>/g;
const LINK_COMMENT =
  /^(?:[ \t]*>)*[ \t]*\[[^\]\n]+\]:[ \t]*(?:#|<>)[ \t]*(?:\([^\n]*\)|"[^\n]*"|'[^\n]*')?[ \t]*$/gm;

/**
 * A line that could open an HTML block: after indentation and any blockquote or list markers, a `<`
 * that starts a tag, comment, declaration or processing instruction. Indentation is not capped at
 * CommonMark's three spaces, because inside a list item more is still a block start; an indented
 * code block that begins with `<` reads as one too, on the safe side.
 */
const HTML_BLOCK_LINE =
  /^(?:[ \t]*(?:>|(?:[-*+]|\d{1,9}[.)])(?=[ \t])))*[ \t]*<[A-Za-z!?/]/m;

/** An opener with no closer: what is left of `<!--` once every closed comment is gone. */
const UNTERMINATED = "<!--";

/** Replace every match of `pattern`, counting them. */
const removeAll = (
  text: string,
  pattern: RegExp,
): { readonly text: string; readonly found: number } => {
  let found = 0;
  const next = text.replace(pattern, () => {
    found += 1;
    return "";
  });
  return { text: next, found };
};

/**
 * Closed comments and the other invisible markup, until none is left — removing one must not join
 * the pieces around it into another — and then an unterminated `<!--`.
 *
 * An unterminated opener hides the rest of the text only where raw HTML is read: when it opens an
 * HTML block, or sits after one, a browser reads it as a comment running to the end. In markdown
 * with no HTML block at all, CommonMark shows an unclosed `<!--` as literal text (a bug report that
 * quotes one in backticks, say), so it stays and the agent reads the whole body a reviewer does.
 * Whether the text has an HTML block is asked of the text as it arrived, before any removal, since
 * that is what the renderer saw: a closed comment at the start of a line still opened a block.
 */
const removeComments = (
  text: string,
): {
  readonly text: string;
  readonly comments: number;
  readonly markup: number;
} => {
  const rawHtml = HTML_BLOCK_LINE.test(text);
  let comments = 0;
  let markup = 0;
  let current = text;
  for (;;) {
    const closed = removeAll(current, CLOSED_COMMENT);
    const bogus = removeAll(closed.text, BOGUS_COMMENT);
    const linked = removeAll(bogus.text, LINK_COMMENT);
    if (closed.found + bogus.found + linked.found === 0) break;
    comments += closed.found;
    markup += bogus.found + linked.found;
    current = linked.text;
  }
  const open = current.indexOf(UNTERMINATED);
  if (rawHtml && open !== -1) {
    return { text: current.slice(0, open), comments: comments + 1, markup };
  }
  return { text: current, comments, markup };
};

/** The text an agent may read: normalized, with every hidden character, comment and invisible markup removed. */
export const sanitizeTriggerText = (text: string): SanitizedText => {
  const visible = removeHidden(text.normalize("NFKC"));
  const uncommented = removeComments(visible.text);
  return {
    text: uncommented.text.normalize("NFKC"),
    hidden: visible.hidden,
    comments: uncommented.comments,
    markup: uncommented.markup,
  };
};

/**
 * What a recorded reason appends when the pass removed anything — `removed 3 hidden characters and
 * 1 HTML comment from the delivery's text`, with `N pieces of invisible markup` beside them — or `undefined` when it removed nothing, so a clean
 * delivery's reason reads as it always did.
 */
export const sanitizedNote = (removed: {
  readonly hidden: number;
  readonly comments: number;
  readonly markup?: number;
}): string | undefined => {
  const markup = removed.markup ?? 0;
  const parts = [
    ...(removed.hidden === 0
      ? []
      : [
          `${removed.hidden} hidden character${removed.hidden === 1 ? "" : "s"}`,
        ]),
    ...(removed.comments === 0
      ? []
      : [
          `${removed.comments} HTML comment${removed.comments === 1 ? "" : "s"}`,
        ]),
    ...(markup === 0
      ? []
      : [`${markup} ${markup === 1 ? "piece" : "pieces"} of invisible markup`]),
  ];
  return parts.length === 0
    ? undefined
    : `removed ${parts.join(" and ")} from the delivery's text`;
};
