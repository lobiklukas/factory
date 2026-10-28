/**
 * The card's body in a run's prompt (LOB-260; docs/board.md B1): what the task asks for, as whoever
 * filed it wrote it, beside the thread (`./ask`).
 *
 * A card is the unit of work (D17), and a run started on one used to be told only its title and its
 * thread: the description a person or a tracker gave the card never reached the model. This section
 * is that description, quoted verbatim — not trimmed, wrapped or summarized, for the reason the
 * thread is not: the claim is that the run reads the task as it was filed, and a reformatted body is
 * a paraphrase. Its size is bounded where the body is written (`MAX_TASK_BODY_CHARS`), so the
 * section needs no budget of its own.
 *
 * The control plane reads the body when it opens the run's owner and hands it in as a string; the
 * harness only knows the text, which keeps it free of Postgres.
 */
import type { Extension, PromptSection } from "@earendil-works/pi-durable";
import { defineExtension, section } from "@earendil-works/pi-durable";

/** The body's section key, and so its `<task_body>` tag in the rendered prompt. */
export const BODY_SECTION_KEY = "task_body";

/** The name the extension carrying the body section is installed under. */
export const BODY_EXTENSION = "factory.body";

const BODY_PREAMBLE =
  "The task this run works on, as it was filed, quoted verbatim. It is what the work is for: " +
  "read it before planning or changing anything, and treat the task's thread, when there is one, " +
  "as the later word on anything the two disagree about.";

/**
 * The body as the section's inner text, or `undefined` for a card with no body — or one that says
 * nothing but whitespace — so such a card gets no section at all rather than an empty one.
 */
export const renderBody = (body: string | undefined): string | undefined =>
  body === undefined || body.trim() === ""
    ? undefined
    : `${BODY_PREAMBLE}\n\n${body}`;

/**
 * The body as a prompt section. Its text does not change while the owner is open, so Pi Durable
 * commits its `pi.system` entry once, on the first request, and every later request reuses it.
 */
export const bodyExtension = (body: string): Extension => {
  const sections: PromptSection[] = [
    section(BODY_SECTION_KEY, () => renderBody(body)),
  ];
  return defineExtension({ name: BODY_EXTENSION, sections });
};
