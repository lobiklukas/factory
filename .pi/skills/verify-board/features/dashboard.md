# The board read back in the dashboard

**Status: passing.**

## What it is

After the CLI's moves and refusals, the dashboard (`apps/web`, `/boards/<board>?card=<card>`) shows
the card where the server holds it, and offers a person the move the run was refused, marked as the
gate it crosses (LOB-76).

## How a user reaches it

Open the board in the browser and click the card; the URL names it, so a link opens the same pane.

## How the skill drives it

`web.mjs`, the drive's last phase, opens the card's URL in headless Chrome against `./up.sh`'s web
port and compares what the page renders with the server's `getTask`, asked from the drive process:

- the card's lane (`section[data-lane]` around `li[data-card]`) is `planning`, as the server says;
- the card pane's column is the server's, and both the pane's revision (`data-card-pane-*`) and the
  server's are the revision the last accepted move returned (`EXPECT_REVISION`, from `drive.sh`) —
  none of the three refusals wrote a revision;
- the pane offers `building` with `data-human-gate="plan approval"`: the move a run was refused is a
  person's move here, and it is marked.

Evidence: `web.json` (the checks, the rendered lanes and pane, the server's answer) and
`web-board.png`.

## What it does not prove

Clicking a move, or a refusal shown in the pane — that walk is `.pi/skills/verify-web`'s
`features/card-pane.md`.
