#!/usr/bin/env bash
# Prove the "Open pull request" control (C7): a repo-bound, idle session with no PR offers it in the
# session pane's header and on its run's row in the card pane; pressing it opens the PR through
# `openPullRequest` and shows the link in both panes without a reload; a second press makes no
# second request to the forge; and a refusal — an empty branch, a diff over the cap, no credential —
# is shown in the server's words with the button disabled. A forge refusal that repeats (a 422 naming
# the PR already open) is not offered as a retry and links that PR, one that passes (a 502) is; a
# refusal is dropped once the server reports the session moved on, with no pane watching a run; and a
# card's run older than the newest 50 sessions still has its row control.
#
# This script owns its own API, dashboard and loopback GitHub fake (its own ports, session root,
# fixture checkouts, ledger, logs and pid files), so the instance ./up.sh starts is not touched and
# nothing is left running. It runs the instance twice: once with a forge and a token (the PR
# opens, the cap and the empty branch refuse), once with no credential at all (the refusal the
# missing token makes). Nothing reaches github.com: the API's `GITHUB_API_URL` is the fake.
#
#   ./pr.sh
#   PR_API_PORT=9570 PR_WEB_PORT=3570 PR_GITHUB_PORT=9571 ./pr.sh     # another port set
#
# Needs `DATABASE_URL` (or the default database) on 5442, as every verify skill does.
# Evidence: .verify/evidence/latest/pr/{fake,off}/ — pr-*.png, observed.json, ledger.json, api.log.
set -uo pipefail

# This suite runs its API with auth off (LOB-20); see up.sh.
unset FACTORY_API_TOKEN FACTORY_API_TOKENS VITE_FACTORY_API_TOKEN FACTORY_API_AUTH

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${PR_API_PORT:-9442}"
WEB_PORT="${PR_WEB_PORT:-3442}"
GH_PORT="${PR_GITHUB_PORT:-9443}"
RUN_DIR="$ROOT/.verify/run/pr"
EVIDENCE_BASE="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/pr"
FAKE="$ROOT/.pi/skills/verify-api/github-fake.ts"

for port in "$API_PORT" "$WEB_PORT" "$GH_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is already in use — set PR_API_PORT / PR_WEB_PORT / PR_GITHUB_PORT to free ones" >&2
    exit 1
  fi
done

stop() { # name
  local pidfile="$RUN_DIR/$1.pid"
  [ -f "$pidfile" ] || return 0
  local pid; pid="$(cat "$pidfile")"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$pidfile"
}
stop_all() { stop web; stop api; stop github; }
trap stop_all EXIT

source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

# What a session's one scripted command does, decided by a marker file the fixture checkout carries
# on `main`: `change` commits one small file, `big` commits more lines than the diff cap allows,
# anything else (the `empty` checkout) changes nothing. One instance, three behaviours, because
# under faux a model *is* its script and FAUX_COMMAND is the same for every session.
COMMIT="git add -A && git -c user.email=verify-pr@localhost -c user.name=verify-pr commit -q -m run"
FAUX_COMMAND="case \"\$(cat .verify-pr 2>/dev/null)\" in change|dup|flaky) echo change > change.txt; $COMMIT;; big) seq 1 2600 > big.txt; $COMMIT;; esac; echo faux-ok"

# Forge answers scripted by the PR's title (C7b), from the same fake that opens PRs for every other
# session: `dup` is the refusal that repeats, a 422 whose reason names a PR already open for the head,
# and `flaky` the one that passes, a 502. The sessions of those two kinds run the `change` script.
FORGE_REFUSALS='[
  {"title":"verify-pr dup","status":422,"body":{"message":"Validation Failed","errors":[{"resource":"PullRequest","code":"custom","message":"A pull request already exists for verify-pr:factory/dup: https://github.com/verify-pr/dup/pull/99"}]}},
  {"title":"verify-pr flaky","status":502,"body":{"message":"Bad Gateway"}}
]'

run_mode() { # fake | off
  local mode="$1"
  local evidence="$EVIDENCE_BASE/$mode"
  local ledger="$RUN_DIR/github-ledger.json"
  mkdir -p "$RUN_DIR" "$evidence"
  rm -rf "$RUN_DIR/sessions" "$RUN_DIR/checkouts" "$ledger"
  : > "$RUN_DIR/api.log"

  if [ "$mode" = "fake" ]; then
    ( exec env GITHUB_FAKE_PORT="$GH_PORT" GITHUB_FAKE_LEDGER="$ledger" \
        GITHUB_FAKE_REFUSE="$FORGE_REFUSALS" bun "$FAKE" ) \
      > "$RUN_DIR/github.log" 2>&1 &
    echo $! > "$RUN_DIR/github.pid"
    for _ in $(seq 1 60); do
      grep -q "github-fake listening" "$RUN_DIR/github.log" 2>/dev/null && break
      sleep 0.1
    done
    grep -q "github-fake listening" "$RUN_DIR/github.log" 2>/dev/null || {
      echo "pr: the fake GitHub did not start — see $RUN_DIR/github.log" >&2
      return 1
    }
    GITHUB_ENV=(GITHUB_API_URL="http://127.0.0.1:$GH_PORT" GITHUB_TOKEN="verify-pr-fake-token")
  else
    # Port 9 on loopback: nothing listens, so even a step that got past the missing credential could
    # not reach a real forge.
    GITHUB_ENV=(GITHUB_API_URL="http://127.0.0.1:9")
  fi

  ( cd "$ROOT/apps/api" && exec env \
      -u GITHUB_TOKEN -u GITHUB_APP_ID -u GITHUB_APP_PRIVATE_KEY -u GITHUB_APP_INSTALLATION_ID \
      PORT="$API_PORT" \
      HOST="127.0.0.1" \
      ALLOWED_ORIGINS="http://localhost:$WEB_PORT" \
      MODEL_BACKEND=faux \
      FAUX_COMMAND="$FAUX_COMMAND" \
      "${GITHUB_ENV[@]}" \
      SESSION_ROOT="$RUN_DIR/sessions" \
      SESSION_IDLE_TIMEOUT_MS=600000 \
      bun run src/index.ts ) > "$RUN_DIR/api.log" 2>&1 &
  echo $! > "$RUN_DIR/api.pid"

  ( cd "$ROOT/apps/web" && exec env \
      VITE_PORT="$WEB_PORT" \
      VITE_SERVER_URL="http://localhost:$API_PORT" \
      bun run dev ) > "$RUN_DIR/web.log" 2>&1 &
  echo $! > "$RUN_DIR/web.pid"

  local ready=0
  for _ in $(seq 1 60); do
    if curl -sf -m 1 "http://localhost:$API_PORT/readyz" >/dev/null 2>&1 &&
       curl -sf -m 1 "http://localhost:$WEB_PORT/" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 0.5
  done
  if [ "$ready" -ne 1 ]; then
    echo "pr: the instance did not become ready in 30s — see $RUN_DIR/api.log and $RUN_DIR/web.log" >&2
    return 1
  fi

  WEB_URL="http://localhost:$WEB_PORT" API_URL="http://localhost:$API_PORT" \
    EVIDENCE_DIR="$evidence" RUN_DIR="$RUN_DIR" LEDGER="$ledger" PR_GITHUB="$mode" \
    node "$ROOT/.pi/skills/verify-web/pr.mjs"
  local rc=$?
  cp "$RUN_DIR/api.log" "$evidence/api.log" 2>/dev/null || true
  cp "$RUN_DIR/web.log" "$evidence/web.log" 2>/dev/null || true
  cp "$ledger" "$evidence/ledger.json" 2>/dev/null || true
  stop_all
  return "$rc"
}

rc=0
run_mode fake || rc=1
run_mode off || rc=1

echo
if [ "$rc" -eq 0 ]; then
  echo "pr: all checks passed — evidence in $EVIDENCE_BASE"
else
  echo "pr: FAILURES — see $EVIDENCE_BASE/*/observed.json" >&2
fi
exit "$rc"
