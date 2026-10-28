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
 * 3. **HTML comments are removed**, a `<!--` with no `-->` to the end of the text, until none is
 *    left — removing one must not join the pieces around it into another.
 * 4. **NFKC again**, since a removed character may have separated a sequence that now composes.
 *
 * Nothing else is rewritten: markdown, code, newlines and every visible character stay as written. A
 * comment inside a code block is removed too; the agent never needed text a reviewer could not see.
 */

/** What `sanitizeTriggerText` took out, so a recorded reason can say so. */
export type SanitizedText = {
  readonly text: string;
  /** Hidden characters removed (`isHiddenCodePoint`). */
  readonly hidden: number;
  /** HTML comments removed, an unterminated one included. */
  readonly comments: number;
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
 * An HTML comment as CommonMark reads one: the empty `<!-->` and `<!--->`, a closed comment shortest
 * first, or an opener with no closer, which hides everything after it.
 */
const HTML_COMMENT = /<!--(?:>|->|[\s\S]*?-->|[\s\S]*$)/g;

const removeComments = (
  text: string,
): { readonly text: string; readonly comments: number } => {
  let comments = 0;
  let current = text;
  for (;;) {
    let found = 0;
    const next = current.replace(HTML_COMMENT, () => {
      found += 1;
      return "";
    });
    if (found === 0) return { text: current, comments };
    comments += found;
    current = next;
  }
};

/** The text an agent may read: normalized, with every hidden character and HTML comment removed. */
export const sanitizeTriggerText = (text: string): SanitizedText => {
  const visible = removeHidden(text.normalize("NFKC"));
  const uncommented = removeComments(visible.text);
  return {
    text: uncommented.text.normalize("NFKC"),
    hidden: visible.hidden,
    comments: uncommented.comments,
  };
};

/**
 * What a recorded reason appends when the pass removed anything — `removed 3 hidden characters and
 * 1 HTML comment from the delivery's text` — or `undefined` when it removed nothing, so a clean
 * delivery's reason reads as it always did.
 */
export const sanitizedNote = (removed: {
  readonly hidden: number;
  readonly comments: number;
}): string | undefined => {
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
  ];
  return parts.length === 0
    ? undefined
    : `removed ${parts.join(" and ")} from the delivery's text`;
};
