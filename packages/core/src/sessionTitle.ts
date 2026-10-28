/** Longest title we derive from a first message, in characters. */
export const TITLE_MAX = 80;

/**
 * The title a session derives from its first message: the first non-blank line, trimmed, at most
 * `TITLE_MAX` characters. One rule, so a prompt and the title it will become classify alike when
 * the cost prediction (LOB-38) compares them.
 */
export const titleFrom = (content: string): string => {
  const line =
    content.split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
  return line.trim().slice(0, TITLE_MAX);
};
