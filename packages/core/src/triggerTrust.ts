/**
 * The trust gate on automatic starts (S-trigger-trust-gating): who may start work through a rule,
 * and which items.
 *
 * A signed delivery proves which *system* sent it, not that the person behind it should be able to
 * run an agent on the operator's machine: anyone who can label a Linear issue, or comment on a public
 * GitHub repository, can otherwise put their words into a session. Mastra, Devin, OpenHands, Copilot
 * and Cursor all start work only for trusted authors and only for work created after intake was set
 * up. A rule says the same here (`TriggerRule.trust`), and the seam asks this module before it
 * starts anything:
 *
 * - **created after enable** — `createdAfter`, an instant or `enabled` (a stored route's own
 *   creation): an item the source dates earlier, or does not date at all, is not new work;
 * - **an allowlist** — `authors`, the source's user ids or logins: the delivery's author must be one;
 * - **GitHub permission** — `githubPermission`: or, for a GitHub event, the author's role on the
 *   event's repository, read per delivery from GitHub's collaborator-permission API through
 *   `TriggerAuthorPermissions`, must be at least this one.
 *
 * Every refusal is a sentence the seam records as the delivery's skip reason, naming the author or
 * the item's age. Each starts with a fixed phrase (`UNTRUSTED_AUTHOR_PATTERN`,
 * `CREATED_BEFORE_PATTERN`), so a delivery keyed by its work reclaims it: a stranger who labels an
 * issue first must not stop the trusted person who labels it next. A lookup that cannot answer is a
 * `TriggerError` (`author-check`) the sender retries — never an admission.
 */
import { Context, Effect, Option } from "effect";
import type { RepoSlug } from "@repo/domain/Session";
import {
  type GitHubPermission,
  ruleName,
  type TriggerAuthor,
  TriggerError,
  type TriggerEvent,
} from "@repo/domain/Trigger";
import type { RoutedRule } from "./TriggerRoutes";
import { sanitizeTriggerText } from "./triggerText";

/**
 * A user's role on a GitHub repository, as the collaborator-permission API answers it: its
 * `role_name` when that is one of GitHub's base roles, else its legacy `permission` (`admin`, `write`,
 * `read`, `none` — a custom role reads as the base it extends). `none` is "not a collaborator".
 */
export type GitHubRole =
  | "none"
  | "read"
  | "triage"
  | "write"
  | "maintain"
  | "admin";

const GITHUB_ROLE_ORDER: ReadonlyArray<GitHubRole> = [
  "none",
  "read",
  "triage",
  "write",
  "maintain",
  "admin",
];

/** Whether `role` is at least `least`, in GitHub's order. */
export const githubRoleAtLeast = (
  role: GitHubRole,
  least: GitHubPermission,
): boolean =>
  GITHUB_ROLE_ORDER.indexOf(role) >= GITHUB_ROLE_ORDER.indexOf(least);

/**
 * The role an API answer names: `role_name` when it is a base role, else the legacy `permission`,
 * else `none`. Pure, so the mapping is tested without a forge.
 */
export const githubRoleOf = (answer: {
  readonly role_name?: unknown;
  readonly permission?: unknown;
}): GitHubRole => {
  const known = (value: unknown): GitHubRole | undefined =>
    GITHUB_ROLE_ORDER.find((role) => role === value);
  return known(answer.role_name) ?? known(answer.permission) ?? "none";
};

/** What the gate needs of a source to judge an author it does not list: GitHub's role, today. */
export type TriggerAuthorPermissionsShape = {
  /** The role `login` holds on `repo`; a failure is `author-check`, which the sender retries. */
  readonly githubRole: (input: {
    readonly repo: RepoSlug;
    readonly login: string;
  }) => Effect.Effect<GitHubRole, TriggerError>;
};

/**
 * The permission port. Optional on the seam: a seam with no rule that asks for a GitHub permission
 * never needs it, and one whose rule does but that has none wired fails the delivery loudly
 * (`author-check`, the claim given back) rather than admitting an author nobody checked.
 */
export class TriggerAuthorPermissions extends Context.Service<
  TriggerAuthorPermissions,
  TriggerAuthorPermissionsShape
>()("@repo/core/TriggerAuthorPermissions") {}

/** The fixed start of an untrusted-author skip, and the `LIKE` pattern the reclaim matches it by. */
const UNTRUSTED_AUTHOR = "untrusted author";
export const UNTRUSTED_AUTHOR_PATTERN = `${UNTRUSTED_AUTHOR}%`;

/** The fixed start of a too-old skip, and its pattern. */
const CREATED_BEFORE = "created before the rule was enabled";
export const CREATED_BEFORE_PATTERN = `${CREATED_BEFORE}%`;

/** How much of an author's handle or id a reason carries. */
const MAX_AUTHOR_TEXT = 64;

/**
 * A source's name for a person, as a reason may carry it: the sender typed it, so it is cleaned like
 * any delivery text, on one line, and cut — a display name must not be able to forge the rest of the
 * sentence an operator reads.
 */
const oneLine = (text: string): string =>
  sanitizeTriggerText(text)
    .text.replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_AUTHOR_TEXT);

/** How a reason names an author: `octocat (583231)`, or the id alone when it is all there is. */
export const authorText = (author: TriggerAuthor): string => {
  const id = oneLine(author.id);
  const handle = oneLine(author.login ?? author.name ?? "");
  return handle === "" || handle === id ? id : `${handle} (${id})`;
};

/** Whether the allowlist names the author: by id exactly, or by login without regard to case. */
export const authorListed = (
  authors: ReadonlyArray<string>,
  author: TriggerAuthor,
): boolean =>
  authors.some(
    (entry) =>
      entry === author.id ||
      (author.login !== undefined &&
        author.login !== "" &&
        entry.toLowerCase() === author.login.toLowerCase()),
  );

/** How a reason names the rule: `rule "factory" (route trr_…)`. */
const ruleText = (routed: RoutedRule): string =>
  `rule "${ruleName(routed.rule)}"${routed.origin === undefined ? "" : ` (${routed.origin})`}`;

/**
 * The instant a rule takes items from, or why it has none: `createdAfter` itself, or for `enabled`
 * the rule's enable time (`RoutedRule.enabledAt`, a stored route's creation).
 */
const takesFrom = (
  routed: RoutedRule,
  createdAfter: string,
): { readonly since: string } | { readonly missing: string } =>
  createdAfter !== "enabled"
    ? { since: createdAfter }
    : routed.enabledAt !== undefined
      ? { since: routed.enabledAt }
      : {
          missing: `${ruleText(routed)} takes only items created after it was enabled, but it has no enable time (only a stored route has one), so it starts nothing; give trust.createdAfter an instant instead`,
        };

/**
 * The created-after-enable half of the gate: `undefined` when the item is new enough (or the rule
 * does not ask), else the skip reason. Pure: the rule, its enable time and the event decide it.
 */
export const createdAfterRefusal = (
  routed: RoutedRule,
  event: TriggerEvent,
): string | undefined => {
  const createdAfter = routed.rule.trust?.createdAfter;
  if (createdAfter === undefined) return undefined;
  const from = takesFrom(routed, createdAfter);
  if ("missing" in from) return from.missing;
  const created =
    event.createdAt === undefined ? Number.NaN : Date.parse(event.createdAt);
  if (!Number.isFinite(created)) {
    return `${CREATED_BEFORE}, or cannot be told apart from one: the event gives no creation time for ${event.key}, and ${ruleText(routed)} takes only items created from ${from.since}`;
  }
  return created < Date.parse(from.since)
    ? `${CREATED_BEFORE}: ${event.key} was created at ${event.createdAt}, and ${ruleText(routed)} takes only items created from ${from.since}`
    : undefined;
};

/**
 * The whole gate for one claimed event: `undefined` admits it, a string is the skip reason. The age
 * first (no lookup), then the allowlist, then — only for an author the list does not name — the
 * GitHub role, so a listed author costs no API call.
 */
export const trustRefusal = (
  routed: RoutedRule,
  event: TriggerEvent,
  permissions: Option.Option<TriggerAuthorPermissionsShape>,
): Effect.Effect<string | undefined, TriggerError> =>
  Effect.gen(function* () {
    const trust = routed.rule.trust;
    if (trust === undefined) return undefined;
    const tooOld = createdAfterRefusal(routed, event);
    if (tooOld !== undefined) return tooOld;

    const { authors, githubPermission } = trust;
    if (authors === undefined && githubPermission === undefined) {
      return undefined;
    }
    const admits = [
      ...(authors === undefined
        ? []
        : [
            authors.length === 0
              ? "no listed author (its allowlist is empty)"
              : `the authors [${authors.join(", ")}]`,
          ]),
      ...(githubPermission === undefined
        ? []
        : [`GitHub users with ${githubPermission} or higher on the repo`]),
    ].join(" or ");
    const rule = ruleText(routed);

    const author = event.author;
    if (author === undefined) {
      return `${UNTRUSTED_AUTHOR}: the ${event.source} event names no author, and ${rule} admits only ${admits}`;
    }
    const who = authorText(author);
    if (authors !== undefined && authorListed(authors, author)) {
      return undefined;
    }
    const refused = `${UNTRUSTED_AUTHOR} ${who}: ${rule} admits only ${admits}`;
    if (githubPermission === undefined) return refused;
    if (event.source !== "github") {
      return `${refused}, and a ${event.source} author has no GitHub role to check`;
    }
    if (event.repo === undefined || author.login === undefined) {
      return `${refused}, and the event names no ${event.repo === undefined ? "repository" : "login"} to check a GitHub role on`;
    }
    if (Option.isNone(permissions)) {
      return yield* new TriggerError({
        code: "author-check",
        message: `${rule} admits authors by GitHub permission, but this trigger seam has no permission port (TriggerAuthorPermissions) wired to check ${who} with`,
      });
    }
    const role = yield* permissions.value.githubRole({
      repo: event.repo,
      login: author.login,
    });
    return githubRoleAtLeast(role, githubPermission)
      ? undefined
      : `${refused}; their role on ${event.repo} is ${role}`;
  });
