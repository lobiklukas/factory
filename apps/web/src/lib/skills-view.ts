import type {
  PutSkillInput,
  SkillRecord,
  SkillVersionSummary,
} from "@repo/domain/Skill";
import { DASHBOARD_ACTOR } from "./approvals-view";

/**
 * The skill pages' wording and form rules (D8): what `/skills` and `/skills/$name` say about a
 * skill, and what the Edit form sends.
 *
 * Every fact is the server's — `listSkills`, `getSkill`, `listSkillVersions` — and a publish is
 * `putSkill`, which always writes version `newest + 1` and never rewrites one (docs/board.md B2): so
 * an edit reaches the next run in a column that binds the skill, and no run already open. Pure, so
 * the sentences a reader depends on ("v4 created", which version is the newest, what an edit sends)
 * are unit cases rather than something only a screenshot shows.
 */

/** What a field with nothing in it shows, as the settings view does. */
export const NONE = "—";

/** What the Edit form holds: the two fields a `SKILL.md` declares, the description and the body. */
export type SkillForm = {
  readonly description: string;
  readonly body: string;
};

/** The form an Edit opens: the newest version's description and body, as stored. */
export const skillForm = (
  newest: Pick<SkillRecord, "description" | "body">,
): SkillForm => ({
  description: newest.description,
  body: newest.body,
});

/**
 * Whether the form says anything the newest version does not. A put of the same text would still
 * be a new version — one that tells the next run nothing new — so the form refuses to send it, and
 * says so, rather than adding a version that only moves a number.
 */
export const formChanged = (
  form: SkillForm,
  newest: Pick<SkillRecord, "description" | "body">,
): boolean =>
  form.description !== newest.description || form.body !== newest.body;

/**
 * What a Publish sends: the form's description and body under the skill's name, the newest
 * version's attachments (the form has no field for them, so an edit keeps them, as `factory skill
 * put` does), and the dashboard's actor — which an authenticated control plane replaces with the
 * credential's (LOB-20). The body goes as typed: a blank one is the server's `InvalidSkill`, shown in
 * its words, not a rule this page keeps a copy of.
 */
export const publishInput = (
  newest: Pick<SkillRecord, "name" | "attachments">,
  form: SkillForm,
): PutSkillInput => ({
  name: newest.name,
  description: form.description,
  body: form.body,
  attachments: newest.attachments,
  actor: DASHBOARD_ACTOR,
});

/** `v<n>`, the way the pages name a version. */
export const versionLabel = (version: number): string => `v${version}`;

/** What a publish that landed says: the version the server wrote, which is the newest now. */
export const createdMessage = (put: Pick<SkillRecord, "version">): string =>
  `${versionLabel(put.version)} created`;

/** The version a Publish will write, as the button names it: one after the newest the page read. */
export const nextVersion = (newest: Pick<SkillRecord, "newest">): number =>
  newest.newest + 1;

/**
 * What the page says about the version it shows: nothing when it is the newest, else that it is an
 * older one and which is the newest — a run is told the newest, so a reader of an old body must not
 * take it for what runs read.
 */
export const olderVersionNotice = (
  shown: Pick<SkillRecord, "version" | "newest">,
): string | null =>
  shown.version === shown.newest
    ? null
    : `You are reading ${versionLabel(shown.version)}. The newest is ${versionLabel(shown.newest)}: that is the one the next run in a column that binds this skill is told.`;

/** Who put a version: the actor the server recorded, or "seeded" for a migration's row. */
export const authorLabel = (author: string): string =>
  author === "" ? "seeded" : author;

/** A description on one line, as the list shows it: a frontmatter block can span several. */
export const oneLine = (text: string): string =>
  text.replace(/\s+/g, " ").trim() || NONE;

/** The version a `?version=` search names, if it names one: a positive integer, else the newest. */
export const versionSearch = (value: unknown): number | undefined => {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

/**
 * The history the page lists, newest first, with which entry is the one shown: what a press on an
 * entry opens. The list is `listSkillVersions`' order, which is the server's.
 */
export const historyRows = (
  history: ReadonlyArray<SkillVersionSummary>,
  shown: number,
): ReadonlyArray<SkillVersionSummary & { readonly current: boolean }> =>
  history.map((entry) => ({ ...entry, current: entry.version === shown }));

/** A refused publish: which refusal it was and the server's message verbatim. */
export type SkillRefusal = {
  readonly tag: string;
  readonly message: string;
};

/**
 * What a failed `putSkill` shows. A typed refusal (`InvalidSkill`, a storage error) is shown in the
 * server's own words; anything else (a dropped connection, a name the payload schema refuses) falls
 * back to the cause.
 */
export const skillRefusal = (
  error: { readonly _tag: string; readonly message: string } | undefined,
  fallback: string,
): SkillRefusal =>
  error === undefined || error.message.length === 0
    ? { tag: error?._tag ?? "Unknown", message: fallback }
    : { tag: error._tag, message: error.message };

/**
 * What a Publish says when the newest moved after the form opened: someone (`factory skill put`,
 * another browser) wrote a version the typed text never saw. `putSkill` writes `newest + 1` whatever
 * the form was read from, so sending it unasked would quietly supersede that version's text. The
 * form keeps what was typed and starts from the fresh newest, so a second Publish writes over it on
 * purpose. `null` when the newest is still the one the form opened on.
 */
export const movedRefusal = (
  base: Pick<SkillRecord, "newest">,
  fresh: Pick<SkillRecord, "newest">,
): SkillRefusal | null =>
  fresh.newest === base.newest
    ? null
    : {
        tag: "NewestMoved",
        message: `${versionLabel(fresh.newest)} was published after this form opened on ${versionLabel(base.newest)}, so nothing was sent. Your text is kept: Publish again to write ${versionLabel(fresh.newest + 1)} over it, or Cancel and Edit to start from ${versionLabel(fresh.newest)}.`,
      };
