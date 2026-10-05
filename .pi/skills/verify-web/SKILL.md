---
name: verify-web
description: Drive and prove the factory web dashboard (React SPA at apps/web) in a real browser, together with the Effect API behind it (apps/api). Use when asked to verify, test, or show evidence that the dashboard or its API works, or when a change to apps/web, apps/api, or packages/domain needs proof beyond unit tests.
---

# Verify the web dashboard

Proves behavior by driving the real dashboard in a real browser and capturing evidence.
Unit tests and type checks do not replace this: the streaming card once type-checked and rendered
while the stream silently did nothing (see `features/session-stream.md`).

Two surfaces exist in this repo. This skill covers the **web dashboard** plus the API it calls.
The **CLI** (`apps/cli`) is a separate surface with its own skill — `.pi/skills/verify-cli`, which
drives `factory run`/`watch`/`ls` in a real tmux terminal. Use that one for command-line changes;
this one for anything a person clicks.

## Launch

Run on isolated ports so the run never competes with a dev server you already have open.
Port 3000 in particular is often taken by something else, and Vite is configured `strictPort`,
so it will fail rather than pick another port.

```sh
./up.sh          # api on :9100, web on :3100; pids recorded in .verify/run/
./down.sh        # stops only what up.sh started
```

`up.sh` waits for both surfaces to answer and fails loudly with log paths if they don't
(`.verify/run/api.log`, `.verify/run/web.log`). Override with `API_PORT=` / `WEB_PORT=`.

`ALLOWED_ORIGINS` must name the web port or the browser's request to the API is blocked by
CORS. `up.sh` sets it for you.

## Doctor

```sh
./doctor.sh      # read-only; exits non-zero when the instance is not worth driving
```

Checks that the recorded pids are alive, that our ports are owned by us, and that both
surfaces answer. Port ownership compares against the recorded pid **and its descendants**,
because `bun run dev` starts Vite as a child process. Run this first whenever anything looks
off — do not trust a drive run against an instance that fails the doctor.

## Drive

```sh
node drive.mjs   # requires the instance from ./up.sh to be running
```

Uses the locally installed Chrome (`channel: "chrome"`), so no Playwright browser download is
needed. Environment: `WEB_URL`, `API_URL`, `EVIDENCE_DIR`.

It asserts the shell renders, asserts the browser can reach the API from the page's own origin,
and clicks **Start a session**, requiring the transcript to reach the answer the agent's `bash`
tool produced and the card to label its read path. Exit code is non-zero when a required check
fails.

The dashboard drives the API, and the API needs Postgres: `docker compose up -d --wait postgres`
before `./up.sh`. The session's model is scripted (`MODEL_BACKEND=faux`) so the run is offline and
deterministic; its tool calls, transcript, and storage are real.

## Evidence

Written to `.verify/evidence/latest/` (override with `EVIDENCE_DIR`), gitignored:

- `dashboard.png` — full-page screenshot after the drive
- `observed.json` — heading, per-check pass/fail with details, the API body, the session card's
  transcript and mode label, console errors, and HTTP responses ≥ 400

Proof standards for this app:

- Exercise the real control a user touches. Click the button; do not call the client from the
  test process. `api-connectivity` deliberately runs its `fetch` **inside the page** so it
  proves CORS and reachability through the client's origin, which a curl from the shell would not.
- Capture the action and the resulting state: the screenshot plus the extracted text, not one or
  the other.
- A green unit test is not evidence for a browser path. The streaming card was the proof: it
  compiled, rendered, and did nothing.
- Chrome logs a 404 for a resource that never appears in Playwright's response events (it is a
  favicon-class request). It is not a failure of the drive and `failedResponses` will be empty
  for it. Do not chase it.
- Require the end of the story, not the beginning. The session card check waits for the _answer_,
  which exists only once the tool call, the transcript commit, and the stream all worked.

## Cleanup

```sh
./down.sh        # kills only the pids up.sh recorded, removes .verify/run/
```

Never kill by process name — this machine runs other Vite/Node servers, and one of them may
hold port 3000. Cleanup removes the instance and its scratch state and deliberately does not
touch `.verify/evidence/`; after cleanup, confirm the evidence is still there.

## Helpers

| File        | Purpose                                                           |
| ----------- | ----------------------------------------------------------------- |
| `up.sh`     | Launch isolated API + web, wait for readiness                     |
| `down.sh`   | Stop only what `up.sh` started                                    |
| `doctor.sh` | Read-only health check of the instance                            |
| `drive.mjs` | Browser drive + evidence capture                                  |
| `features/` | Feature map: what each user-facing feature is and how to prove it |

## Feature map

Start at `features/README.md`. It lists what exists and whether it currently passes.
