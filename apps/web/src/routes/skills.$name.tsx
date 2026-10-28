import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Cause, Exit, Option } from "effect";
import {
  BookOpenTextIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  PencilIcon,
} from "lucide-react";
import { useState, type FormEvent } from "react";
import type { SkillRecord } from "@repo/domain/Skill";
import {
  putSkillAtom,
  readNewestSkillAtom,
  skillAtom,
  skillsAtom,
  skillVersionsAtom,
} from "@/lib/atoms/skills-atom";
import {
  authorLabel,
  createdMessage,
  formChanged,
  historyRows,
  movedRefusal,
  nextVersion,
  NONE,
  olderVersionNotice,
  oneLine,
  publishInput,
  skillForm,
  skillRefusal,
  versionLabel,
  versionSearch,
  type SkillForm,
  type SkillRefusal,
} from "@/lib/skills-view";
import { EmptyPane } from "@/components/empty-pane";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

/**
 * `?version=N` shows that version's body instead of the newest's: what a history entry links to.
 * Anything that is not a positive integer reads as the newest.
 */
type SkillSearch = { readonly version?: number | undefined };

export const Route = createFileRoute("/skills/$name")({
  validateSearch: (search: Record<string, unknown>): SkillSearch => {
    const version = versionSearch(search["version"]);
    return version === undefined ? {} : { version };
  },
  component: SkillRoute,
});

/**
 * One skill (D8): a version's body, who put it and when, the default definition's columns that bind
 * it, every version it holds, and the Edit form that publishes the next one with `putSkill`.
 *
 * Three reads, each the server's: `getSkill` (the version shown, and the newest, which the form edits
 * from), `listSkillVersions` (the history) and `listSkills` (which columns bind it). A publish never
 * rewrites a version (B2): it adds `newest + 1`, and every read here re-runs once it lands.
 */
function SkillRoute() {
  const { name } = Route.useParams();
  const { version } = Route.useSearch();
  const shown = useAtomValue(skillAtom({ name, version }));
  // The last version this page showed. Another version's read starts out Initial (each version is
  // its own atom), and replacing the page with a skeleton then would unmount the Edit form and lose
  // what was typed — so a history entry pressed mid-edit keeps the page, form included, on screen
  // until the version it names is read.
  const [kept, setKept] = useState<SkillRecord | undefined>(undefined);
  if (AsyncResult.isSuccess(shown) && shown.value !== kept) {
    setKept(shown.value);
  }

  if (AsyncResult.isInitial(shown)) {
    if (kept !== undefined && kept.name === name) {
      return <SkillPage key={name} skill={kept} loading />;
    }
    return (
      <div role="status" className="flex flex-1 flex-col gap-3 p-6">
        <span className="sr-only">Loading the skill</span>
        {[0, 1].map((row) => (
          <Skeleton key={row} className="h-32 w-full max-w-4xl" aria-hidden />
        ))}
      </div>
    );
  }

  if (AsyncResult.isFailure(shown)) {
    const error = Cause.findErrorOption(shown.cause);
    const missing =
      Option.isSome(error) && error.value._tag === "SkillNotFound";
    return (
      <EmptyPane
        icon={<BookOpenTextIcon strokeWidth={1.75} />}
        title={
          !missing
            ? "The skill did not load"
            : error.value.version === undefined
              ? "No such skill"
              : "No such version"
        }
        detail={missing ? error.value.message : Cause.pretty(shown.cause)}
        visible
        action={
          <Link
            to="/skills"
            className="text-xs underline underline-offset-2"
            data-skill-missing={name}
          >
            Every skill
          </Link>
        }
      />
    );
  }

  return <SkillPage key={name} skill={shown.value} loading={false} />;
}

/**
 * The page for one version, once it is read. Keyed by the skill's name, so another skill's page never
 * inherits this one's form; `loading` is another version of the same skill being read meanwhile.
 */
const SkillPage = ({
  skill,
  loading,
}: {
  readonly skill: SkillRecord;
  readonly loading: boolean;
}) => {
  const notice = olderVersionNotice(skill);
  return (
    <div
      data-skill-page={skill.name}
      data-skill-loading={loading ? "" : undefined}
      aria-busy={loading || undefined}
      data-skill-shown-version={skill.version}
      data-skill-newest={skill.newest}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
    >
      <header className="flex flex-col gap-2 border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <Link
            to="/skills"
            data-skills-link
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Skills
          </Link>
          <h1 className="font-mono text-sm font-medium">{skill.name}</h1>
          <span className="font-mono text-[10px] text-muted-foreground">
            {versionLabel(skill.version)}
            {skill.version === skill.newest ? " (newest)" : ""}
          </span>
        </div>
        <p data-skill-description className="max-w-4xl text-xs">
          {oneLine(skill.description)}
        </p>
        {notice === null ? null : (
          <p
            role="status"
            data-skill-older
            className="flex max-w-4xl flex-wrap items-baseline gap-x-2 border border-border bg-muted/40 px-3 py-2 text-xs"
          >
            {notice}
            <Link
              to="/skills/$name"
              params={{ name: skill.name }}
              data-skill-show-newest
              className="underline underline-offset-2"
            >
              Show {versionLabel(skill.newest)}
            </Link>
          </p>
        )}
      </header>
      <div className="grid max-w-6xl gap-6 p-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <section aria-label="Body" className="flex min-w-0 flex-col gap-3">
          <SkillEditor name={skill.name} />
          <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11px]">
            <dt className="text-muted-foreground">Put by</dt>
            <dd data-skill-author className="font-mono">
              {authorLabel(skill.author)}
            </dd>
            <dt className="text-muted-foreground">Put at</dt>
            <dd data-skill-created-at className="font-mono">
              {skill.createdAt}
            </dd>
            <dt className="text-muted-foreground">Attachments</dt>
            <dd data-skill-attachments className="font-mono break-all">
              {skill.attachments.length === 0
                ? NONE
                : skill.attachments.join(", ")}
            </dd>
          </dl>
          <pre
            data-skill-body
            className="min-w-0 overflow-x-auto border border-border bg-card px-3 py-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap"
          >
            {skill.body}
          </pre>
        </section>
        <aside className="flex flex-col gap-6">
          <UsedBy name={skill.name} />
          <History name={skill.name} shown={skill.version} />
        </aside>
      </div>
    </div>
  );
};

/**
 * Which columns bind the skill: the default definition's newest version's, from `listSkills`, as
 * `factory skill ls` prints them — the runs an edit reaches. A failed list says it could not tell
 * rather than claiming no column does.
 */
const UsedBy = ({ name }: { readonly name: string }) => {
  const result = useAtomValue(skillsAtom);
  const columns = AsyncResult.isSuccess(result)
    ? (result.value.find((skill) => skill.name === name)?.columns ?? [])
    : undefined;
  return (
    <section aria-label="Used by" className="flex flex-col gap-1.5">
      <h2 className="text-xs font-medium">Used by</h2>
      <p className="text-[11px] text-muted-foreground">
        Columns of the default definition&apos;s newest version that bind it.
        The next run in each is told the newest version.
      </p>
      {AsyncResult.isFailure(result) ? (
        <p
          data-skill-used-by-unknown
          title={Cause.pretty(result.cause)}
          className="text-[11px] text-destructive"
        >
          Which columns bind it could not be read.
        </p>
      ) : columns === undefined ? (
        <Skeleton className="h-5 w-32" aria-hidden />
      ) : columns.length === 0 ? (
        <p data-skill-used-by={""} className="text-[11px]">
          No column of the default definition binds it.
        </p>
      ) : (
        <ul
          data-skill-used-by={columns.join(",")}
          className="flex flex-wrap gap-1"
        >
          {columns.map((column) => (
            <li key={column}>
              <Badge
                variant="outline"
                data-skill-column
                className="font-mono text-[10px]"
              >
                {column}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

/**
 * Every version the skill holds, newest first (`listSkillVersions`), each a link to its body; the one
 * shown is marked. Re-read once a publish lands, so a new version is listed without a reload.
 */
const History = ({
  name,
  shown,
}: {
  readonly name: string;
  readonly shown: number;
}) => {
  const result = useAtomValue(skillVersionsAtom(name));
  return (
    <section aria-label="History" className="flex flex-col gap-1.5">
      <h2 className="text-xs font-medium">History</h2>
      {AsyncResult.isInitial(result) ? (
        <Skeleton className="h-16 w-full" aria-hidden />
      ) : AsyncResult.isFailure(result) ? (
        <p
          data-skill-history-unknown
          title={Cause.pretty(result.cause)}
          className="text-[11px] text-destructive"
        >
          The history could not be read.
        </p>
      ) : (
        <ol data-skill-history className="flex flex-col gap-1">
          {historyRows(result.value, shown).map((entry) => (
            <li key={entry.version} data-skill-history-version={entry.version}>
              <Link
                to="/skills/$name"
                params={{ name }}
                search={{ version: entry.version }}
                aria-current={entry.current ? "page" : undefined}
                className="flex flex-col gap-0.5 border border-border px-2.5 py-1.5 text-[11px] hover:bg-muted/40 aria-[current=page]:bg-muted"
              >
                <span className="flex items-baseline gap-2">
                  <span className="font-mono font-medium">
                    {versionLabel(entry.version)}
                  </span>
                  <span className="font-mono text-muted-foreground">
                    {authorLabel(entry.author)}
                  </span>
                </span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {entry.createdAt}
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
};

/**
 * The Edit form (D8): the newest version's description and body, and Publish, which sends
 * `putSkill`. The server writes `newest + 1`; the page says "v<n> created" with the number it wrote,
 * shows that version, and the history lists it once the re-read lands. A refusal (a blank body is
 * `InvalidSkill`) is shown inline in the server's words and the form keeps what was typed.
 *
 * The form always edits the newest version, whichever version the page shows: an edit supersedes
 * the newest, so its text is what the person starts from. The page's reads are not polled, so the
 * form never trusts them for "the newest": Edit reads it fresh and opens on that (`base`), and
 * Publish reads it again first — if a version landed since (`factory skill put`, another browser),
 * nothing is sent, the form says so and keeps the text, and a second Publish writes over it on
 * purpose. `putSkill` has no expected-version guard, so a put that lands between that read and the
 * send still wins the race; see the feature's Known gaps.
 */
const SkillEditor = ({ name }: { readonly name: string }) => {
  const newest = useAtomValue(skillAtom({ name, version: undefined }));
  const readNewest = useAtomSet(readNewestSkillAtom, { mode: "promiseExit" });
  const put = useAtomSet(putSkillAtom, { mode: "promiseExit" });
  const navigate = useNavigate();
  const [form, setForm] = useState<SkillForm | null>(null);
  // The newest version the open form was read from: what Publish compares the server's newest to.
  const [base, setBase] = useState<SkillRecord | null>(null);
  const [opening, setOpening] = useState(false);
  const [openFailure, setOpenFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<SkillRefusal | null>(null);
  const [unchanged, setUnchanged] = useState(false);
  const [created, setCreated] = useState<SkillRecord | null>(null);

  const record = AsyncResult.isSuccess(newest) ? newest.value : undefined;
  // A re-read in flight (right after a publish lands) may still hold the version before it.
  const settled = record !== undefined && !newest.waiting;

  const open = () => {
    if (!settled || opening) return;
    setOpening(true);
    setOpenFailure(null);
    setCreated(null);
    setRefusal(null);
    setUnchanged(false);
    void readNewest({ name, known: record.newest })
      .then((exit) => {
        if (Exit.isSuccess(exit)) {
          setBase(exit.value);
          setForm(skillForm(exit.value));
          return;
        }
        setOpenFailure(Cause.pretty(exit.cause));
      })
      .finally(() => setOpening(false));
  };

  const close = () => {
    setForm(null);
    setBase(null);
    setRefusal(null);
    setUnchanged(false);
  };

  const edit =
    (field: keyof SkillForm) =>
    (event: FormEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (form === null) return;
      setForm({ ...form, [field]: event.currentTarget.value });
      setRefusal(null);
      setUnchanged(false);
    };

  const refuse = (cause: Cause.Cause<{ _tag: string; message: string }>) =>
    setRefusal(
      skillRefusal(
        Option.getOrUndefined(Cause.findErrorOption(cause)),
        Cause.pretty(cause),
      ),
    );

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (form === null || base === null || pending) return;
    if (!formChanged(form, base)) {
      setUnchanged(true);
      return;
    }
    setRefusal(null);
    setPending(true);
    void readNewest({ name, known: base.newest })
      .then(async (read) => {
        if (Exit.isFailure(read)) {
          refuse(read.cause);
          return;
        }
        const moved = movedRefusal(base, read.value);
        if (moved !== null) {
          // Start from the version that landed, so the next Publish is a choice to write over it.
          setBase(read.value);
          setRefusal(moved);
          return;
        }
        const exit = await put(publishInput(base, form));
        if (Exit.isSuccess(exit)) {
          setForm(null);
          setBase(null);
          setCreated(exit.value);
          // Show the version just written, which is the newest: the page's `?version=` names an
          // older one if it was open on one.
          void navigate({
            to: "/skills/$name",
            params: { name },
            search: {},
          });
          return;
        }
        refuse(exit.cause);
      })
      .finally(() => setPending(false));
  };

  return (
    <div className="flex flex-col gap-3">
      {created === null ? null : (
        <p
          role="status"
          data-skill-created={created.version}
          className="flex items-center gap-1.5 text-xs"
        >
          <CircleCheckIcon className="size-3.5" strokeWidth={1.75} />
          <span className="font-medium">{createdMessage(created)}</span>
          <span className="text-muted-foreground">
            — the next run in a column that binds {name} is told it; runs
            already open keep the version they opened with.
          </span>
        </p>
      )}
      {form === null || base === null ? (
        <div className="flex flex-col gap-1.5">
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-skill-edit
              disabled={!settled || opening}
              aria-busy={opening || undefined}
              onClick={open}
            >
              {opening ? (
                <Spinner className="size-3.5" />
              ) : (
                <PencilIcon className="size-3.5" strokeWidth={1.75} />
              )}
              Edit
            </Button>
          </div>
          {openFailure === null ? null : (
            <p
              role="alert"
              data-skill-open-failed
              title={openFailure}
              className="text-xs text-destructive"
            >
              The newest version could not be read, so the form did not open.
            </p>
          )}
        </div>
      ) : (
        <form
          data-skill-form
          data-skill-form-base={base.newest}
          onSubmit={submit}
          noValidate
          className="flex flex-col gap-3 border border-border bg-card p-3"
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="skill-description">Description</Label>
            <Input
              id="skill-description"
              name="description"
              value={form.description}
              onInput={edit("description")}
              autoComplete="off"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="skill-body">Body</Label>
            <Textarea
              id="skill-body"
              name="body"
              value={form.body}
              onInput={edit("body")}
              spellCheck={false}
              aria-invalid={refusal === null ? undefined : true}
              aria-describedby={refusal === null ? undefined : "skill-refusal"}
              className="min-h-64 font-mono text-[11px] leading-relaxed"
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            Publishing writes {versionLabel(nextVersion(base))}. No version is
            rewritten: a run already open keeps the one it opened with, and the
            next run in a column that binds {name} is told this one.
          </p>
          {unchanged ? (
            <p
              role="alert"
              data-skill-problem="unchanged"
              className="text-xs text-destructive"
            >
              Nothing changed: the description and body are the newest
              version&apos;s, so publishing would add a version that says
              nothing new.
            </p>
          ) : null}
          {refusal === null ? null : (
            <Alert
              id="skill-refusal"
              variant="destructive"
              role="alert"
              data-skill-refusal={refusal.tag}
            >
              <CircleAlertIcon strokeWidth={1.75} />
              <AlertTitle>The version was not published</AlertTitle>
              <AlertDescription>
                <span className="font-mono text-[11px] break-words">
                  {refusal.message}
                </span>
              </AlertDescription>
            </Alert>
          )}
          <div className="flex gap-2">
            <Button
              type="submit"
              size="sm"
              data-skill-publish
              disabled={pending}
              aria-busy={pending}
            >
              {pending ? <Spinner className="size-3.5" /> : null}
              Publish {versionLabel(nextVersion(base))}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-skill-cancel
              disabled={pending}
              onClick={close}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  );
};
