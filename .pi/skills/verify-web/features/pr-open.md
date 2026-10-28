# Open pull request, from the session pane and the card pane

**Status: passing** (C7, an unfiled draft under LOB-248). A card driven from the browser can leave
`building`, which requires `pr_link`: the PR is opened with a button, not only with `factory pr`.

## What it is

An **Open pull request** button (`data-open-pr`) in two places that are one control:

- the session pane's header, which a card's selected run also shows in its run pane; and
- the run's row in the card pane's **Runs** list (`li[data-run]`), for every run the activity index
  holds.

It is offered (`apps/web/src/lib/pr-open-view.ts`, `prOffer`) when the session is **bound to a repo**,
**idle**, and has **no PR** — no recorded `prUrl` and none opened by this page. A scratch session has no
branch to publish and a busy one is still changing it, so neither is offered the button.

Pressing it calls `openPullRequest` (LOB-213) with the session's id and its own title, as `factory pr`
does; the server chooses the repo, the head and the base. The two panes read one atom per session
(`openPullRequestAtom`), so a press in either is on screen in both without a reload.

- **Opened.** The button is replaced by the link (`data-pr-link`, `PR #N`, the forge's URL verbatim). A
  repeat answers the recorded PR (`already-open`) without asking the forge again; a double press is one
  call from the page.
- **Refused.** An empty branch (`no-change`), a diff over the cap (`over-cap`, naming the limit, the cap
  and what the branch measured) and a missing credential (`CredentialError`) are determinate: the same
  branch and credential would be refused the same way, so the button stays disabled
  (`data-open-pr='blocked'`, `aria-disabled`) with the reason in full beside it (`data-open-pr-reason`:
  on the row beneath the button; for the header a line under it, which has no room for a sentence) and
  as the button's `title`, and a toast. A refusal is dropped once a run starts on the session, because
  the branch may have changed. A forge failure (`PrError`) or a dropped connection is not determinate:
  the reason is shown and the button reads **Retry pull request**.

## How a user reaches it

Open a session that works on a repo, once its run has settled: the header reads `Open pull request`.
Or open a card (`/boards/<board>?card=<card>`), where each run of it has the button on its row.

## Driving it with pr.sh

`./pr.sh` owns its instance (API with `GITHUB_API_URL` the loopback fake and a token it never reads,
dashboard, `verify-api/github-fake.ts`) and runs it twice. With a forge (`fake`), three fixture
checkouts stand for the three things a branch can be (`change`, `big`, `empty`), each carrying a
marker file the instance's one scripted command reads:

1. a scratch session shows no control; an idle `change` session shows it with no link;
2. pressing it shows the link in the header without a reload; the link is the fake's PR for
   `factory/<session>` onto `main` and the one `getSession` records; one create request is in the
   fake's ledger; a reload keeps the link and not the button;
3. a second session is double-clicked: one `openPullRequest` leaves the page and one create reaches the
   fake; two repeats over RPC answer `already-open` and the ledger gains no request, and every request
   the fake saw was a create (no lookup);
4. an `empty` session: the press is refused in the server's words, the button stays disabled with the
   reason, a further press sends nothing, and the fake sees no create for that branch;
5. a `big` session: refused with the numbers the server measured (2600 lines over the cap of 2000);
6. a card's run on `change`: the row and the pane header both offer it; pressing the row's shows the
   link on the row _and_ in the header, the same one, without a reload, one create request; a card's
   run on `empty`: pressing the header's shows the same reason on the row, disabled in both.

Without a credential (`off`), the same press on a `change` session is refused with the missing
token's message, verbatim, equal to what the server answers over RPC, in the header and, for a card's
run, on its row and in the pane header.

## Evidence

`.verify/evidence/latest/pr/fake/` and `.../off/`: `observed.json` (every check), `ledger.json` (every
request the fake saw and every PR it holds), `api.log`, and the screenshots `pr-header-offered.png`,
`pr-header-opened.png`, `pr-header-empty.png`, `pr-header-cap.png`, `pr-card-offered.png`,
`pr-card-opened.png`, `pr-card-refused.png`, `pr-header-credential.png`, `pr-card-credential.png`.

Also driven by verify-board's build phase: the build run's PR is opened by `pr-browser.mjs` from its row
in the card pane, with no `factory pr` ([build.md](../../verify-board/features/build.md)).

Last verified 2026-10-28 from the `agent/C7` worktree (API `:9570`, web `:3570`, the fake on `:9571`):
`pr.sh` passed 22/22 required checks (fake 19, off 3 — see `observed.json` in each).

## What it does not prove

- That GitHub accepts the request as the fake does (`packages/core/src/pr.test.ts` asserts the shape).
- That a run older than the index's newest page has a row control: the index read is `listSessions`'
  first page, so such a run's row offers nothing; the run open in the pane has the header's.
- A run turning busy under an open page (the refusal dropped, the button hidden): the cases are unit
  tests in `apps/web/src/lib/pr-open-view.test.ts`, and the markup in `open-pull-request.test.tsx`.
