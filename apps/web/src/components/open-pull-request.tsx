import { useEffect } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Exit } from "effect";
import { Atom } from "effect/reactivity";
import { GitPullRequestIcon } from "lucide-react";
import { toast } from "sonner";
import type { SessionId, SessionStatus } from "@repo/domain/Session";
import { openPullRequestAtom } from "@/lib/atoms/session-atom";
import { prLink } from "@/lib/pr-link";
import {
  attemptOfCause,
  attemptOfResult,
  attemptOfStep,
  openedUrl,
  prOffer,
  prTitleFor,
  staleRefusal,
} from "@/lib/pr-open-view";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

/**
 * The session's PR, beside its name (LOB-65).
 *
 * The link is what the session recorded (`summary.prUrl`), so it appears on attach for a PR opened
 * earlier and mid-stream when a `prOpened` event lands. A session with no PR shows nothing here —
 * the header is the session's identity, and a "no PR" chip on every new session would be noise. It
 * opens in a new tab: the pane is a live stream, and navigating away from it would drop the attach.
 */
export const PrAnchor = ({ prUrl }: { readonly prUrl: string | undefined }) => {
  const link = prLink(prUrl);
  if (link === null) return null;
  return (
    <a
      data-pr-link
      href={link.href}
      target="_blank"
      rel="noreferrer"
      title={link.href}
      className="flex shrink-0 items-center gap-1 font-mono text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline"
    >
      <GitPullRequestIcon className="size-3.5" strokeWidth={1.75} aria-hidden />
      {link.label}
    </a>
  );
};

/** What the control needs to know about the session it acts on. */
export type PrSession = {
  readonly id: SessionId;
  readonly title: string | undefined;
  readonly repo: string | undefined;
  /** Unknown until the pane has read the session; the control is not offered until then. */
  readonly status: SessionStatus | undefined;
  readonly prUrl: string | undefined;
};

/**
 * The control's button, on its own so its markup can be tested. Never natively `disabled`, for the
 * reason `CompactButton` gives (LOB-232): the press makes it unavailable in the same tick, and a
 * focused `<button>` that becomes `disabled` drops focus to `body`. `aria-disabled` keeps it.
 */
export const OpenPullRequestButton = ({
  state,
  reasonId,
  reason,
  onPress,
}: {
  readonly state: "available" | "opening" | "blocked";
  /** The id of the element that carries the reason in the DOM, for `aria-describedby`. */
  readonly reasonId: string;
  /** Why it cannot be pressed (blocked) or what the last try said (available), or `undefined`. */
  readonly reason: string | undefined;
  readonly onPress: () => void;
}) => {
  const unavailable = state !== "available";
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-open-pr={state}
      aria-busy={state === "opening"}
      aria-describedby={reason === undefined ? undefined : reasonId}
      title={
        state === "blocked"
          ? reason
          : state === "opening"
            ? "Opening the pull request"
            : "Open a pull request for this session's branch"
      }
      disabled={unavailable}
      focusableWhenDisabled
      onClick={() => {
        // Base UI drops a click on an unavailable button already; this keeps the rule local.
        if (unavailable) return;
        onPress();
      }}
    >
      {state === "opening" ? (
        <Spinner className="size-3.5 text-muted-foreground" />
      ) : (
        <GitPullRequestIcon className="size-4" strokeWidth={1.75} />
      )}
      {state === "available" && reason !== undefined
        ? "Retry pull request"
        : "Open pull request"}
    </Button>
  );
};

/**
 * What the control shows for a session, read from the one atom both panes share.
 *
 * `url` is the link once there is one: the recorded `prUrl`, or the answer to a press that just made
 * it, so it appears without waiting for the stream to carry a `prOpened`. `offer` is `prOffer`'s
 * word on the button. A refusal is the verdict on the branch as it stood, so one that a run has
 * outlived (`staleRefusal`) is dropped here, and the control is offered afresh once the session is
 * idle again.
 */
const usePrControl = (session: PrSession) => {
  const result = useAtomValue(openPullRequestAtom(session.id));
  const open = useAtomSet(openPullRequestAtom(session.id), {
    mode: "promiseExit",
  });
  const reset = useAtomSet(openPullRequestAtom(session.id));
  const attempt = attemptOfResult(result);
  const stale = staleRefusal(attempt, session.status);
  useEffect(() => {
    if (stale) reset(Atom.Reset);
  }, [reset, stale]);

  const url = session.prUrl ?? openedUrl(attempt);
  const offer =
    session.status === undefined
      ? ({ _tag: "hidden" } as const)
      : prOffer(
          { repo: session.repo, status: session.status, prUrl: session.prUrl },
          stale ? { _tag: "none" } : attempt,
        );
  const reason =
    offer._tag === "blocked"
      ? offer.reason
      : offer._tag === "available"
        ? offer.retry
        : undefined;
  const press = () => {
    void open(prTitleFor(session.title, session.id)).then((exit) => {
      // The pane that was pressed says so once; the other reads the shared atom.
      const settled = Exit.isSuccess(exit)
        ? attemptOfStep(exit.value)
        : attemptOfCause(exit.cause);
      if (settled._tag === "refused" || settled._tag === "failed") {
        toast.error("No pull request was opened", {
          description: settled.reason,
        });
      }
    });
  };
  return { url, offer, reason, press };
};

const reasonIdOf = (variant: "header" | "row", id: SessionId) =>
  `open-pr-reason-${variant}-${id}`;

/**
 * Open the session's pull request from a pane (C7): the header of the session pane, and the run's
 * row in the card pane. A card cannot leave `building` without a PR (`pr_link`), and until now only
 * `factory pr` opened one.
 *
 * It shows the link once there is one; the button for a repo-bound, idle session without one; and,
 * after a refusal — an empty branch, a diff over the cap, no credential — the button disabled. In
 * the row the server's reason sits beneath it; in the header, which has no room for a sentence, it
 * is `PrReason`'s, a line under the header.
 */
export const PrControl = ({
  session,
  variant,
}: {
  readonly session: PrSession;
  readonly variant: "header" | "row";
}) => {
  const { url, offer, reason, press } = usePrControl(session);

  if (url !== undefined && prLink(url) !== null) {
    return variant === "header" ? (
      <PrAnchor prUrl={url} />
    ) : (
      <div data-run-pr={session.id} className="flex items-center gap-2">
        <PrAnchor prUrl={url} />
      </div>
    );
  }
  if (offer._tag === "hidden") return null;

  const reasonId = reasonIdOf(variant, session.id);
  const button = (
    <OpenPullRequestButton
      state={offer._tag}
      reasonId={reasonId}
      reason={reason}
      onPress={press}
    />
  );
  return variant === "header" ? (
    <span className="shrink-0">{button}</span>
  ) : (
    <div data-run-pr={session.id} className="flex flex-col items-start gap-1">
      {button}
      {reason === undefined ? null : (
        <PrReasonText
          id={reasonId}
          kind={offer._tag}
          reason={reason}
          className="font-mono text-[10px] text-destructive"
        />
      )}
    </div>
  );
};

const PrReasonText = ({
  id,
  kind,
  reason,
  className,
}: {
  readonly id: string;
  readonly kind: string;
  readonly reason: string;
  readonly className: string;
}) => (
  <span
    id={id}
    role="status"
    data-open-pr-reason={kind}
    title={reason}
    className={className}
  >
    {reason}
  </span>
);

/**
 * The header's refusal, on a line of its own under it: the server's reason in full, for as long as
 * the header's button is disabled with it. The header is one line of identity and actions; a sentence
 * beside them would cost the session its name.
 */
export const PrReason = ({ session }: { readonly session: PrSession }) => {
  const { url, offer, reason } = usePrControl(session);
  if (url !== undefined || offer._tag === "hidden" || reason === undefined)
    return null;
  return (
    <div className="shrink-0 border-b border-border px-4 py-1.5">
      <PrReasonText
        id={reasonIdOf("header", session.id)}
        kind={offer._tag}
        reason={reason}
        className="font-mono text-[11px] text-destructive"
      />
    </div>
  );
};
