#!/usr/bin/env bash
# The shell half the three adapter drives share (`jira.sh`, `slack.sh`, `github-issues.sh`, LOB-259):
# each boots one loopback fake of the third party, boots the real API pointed at it, posts signed
# deliveries at the API over HTTP, and boots the API a second time with the route's secret unset to
# prove the `503`. Sourced, not run: `source "$(dirname "$0")/adapter-lib.sh"` after setting ROOT.
#
# Isolation is the same as `pr-rpc.sh`'s: the API's own port, session root, log, pid and the fake's
# own ledger, all under `.verify/run/<name>`; nothing here touches the instance `up.sh` starts, and
# nothing is left running (`adapter_cleanup`, from the caller's EXIT trap).
#
# The API runs `bun run src/index.ts` with `GITHUB_TOKEN` a dummy: the credential seam wants one,
# and no check here sends it anywhere but a loopback fake. `env -u` clears the App variables, which
# would select a token exchange no fake answers.

# adapter_init NAME  — sets RUN_DIR, SESSION_ROOT and the counters; the caller sets ROOT first.
adapter_init() {
  ADAPTER_NAME="$1"
  RUN_DIR="$ROOT/.verify/run/$ADAPTER_NAME"
  SESSION_ROOT="$RUN_DIR/sessions"
  ORIGIN_DIR="$RUN_DIR/origin.git"
  mkdir -p "$RUN_DIR" "$SESSION_ROOT"
  source "$ROOT/.pi/skills/lib/postgres.sh"
  ensure_postgres || exit 1
  # The session root the API opens workspaces under: a real git repo with a local origin, so no git
  # call a session makes can reach a real remote (LOB-94).
  if [ ! -d "$SESSION_ROOT/.git" ]; then
    rm -rf "$SESSION_ROOT" "$ORIGIN_DIR"
    mkdir -p "$SESSION_ROOT"
    git init -q -b main "$SESSION_ROOT"
    git -C "$SESSION_ROOT" config user.email "$ADAPTER_NAME@localhost"
    git -C "$SESSION_ROOT" config user.name "$ADAPTER_NAME-drive"
    git -C "$SESSION_ROOT" commit -q --allow-empty -m "$ADAPTER_NAME drive session root"
    git init -q -b main --bare "$ORIGIN_DIR"
    git -C "$SESSION_ROOT" remote add origin "$ORIGIN_DIR"
    git -C "$SESSION_ROOT" push -q origin main
  fi
}

# adapter_check_ports PORT...  — refuse to bind a port something already holds.
adapter_check_ports() {
  local port
  for port in "$@"; do
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "port $port is already in use — set the drive's port variables to free ones" >&2
      exit 1
    fi
  done
}

adapter_stop_pid() { # pid file
  [ -f "$1" ] || return 0
  local pid; pid="$(cat "$1")"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$1"
}

# adapter_start_fake NAME LEDGER SCRIPT [VAR=value...]  — a ledger-backed fake, ready once it has
# written its (empty) ledger.
adapter_start_fake() {
  local name="$1" ledger="$2" script="$3"; shift 3
  : > "$RUN_DIR/$name.log"
  ( exec env "$@" bun "$script" ) >> "$RUN_DIR/$name.log" 2>&1 &
  echo $! > "$RUN_DIR/$name.pid"
  for _ in $(seq 1 60); do
    [ -s "$ledger" ] && return 0
    sleep 0.1
  done
  echo "the $name fake did not start — see $RUN_DIR/$name.log" >&2
  return 1
}

# adapter_start_api PORT VAR=value...  — the real API on PORT with those variables, ready on /readyz.
# The caller's own environment carries DATABASE_URL, and any trigger variable the drive exports.
adapter_start_api() {
  local port="$1"; shift
  : > "$RUN_DIR/api.log"
  ( cd "$ROOT/apps/api" && exec env \
      -u GITHUB_APP_ID -u GITHUB_APP_PRIVATE_KEY -u GITHUB_APP_INSTALLATION_ID \
      PORT="$port" \
      HOST="127.0.0.1" \
      ALLOWED_ORIGINS="http://127.0.0.1:$port" \
      MODEL_BACKEND=faux \
      GITHUB_TOKEN="adapter-drive-fake-token" \
      SESSION_ROOT="$SESSION_ROOT" \
      SESSION_IDLE_TIMEOUT_MS=600000 \
      DATABASE_URL="${DATABASE_URL:?the adapter drives need DATABASE_URL from the run}" \
      "$@" \
      bun run src/index.ts ) >> "$RUN_DIR/api.log" 2>&1 &
  echo $! > "$RUN_DIR/api.pid"
  for _ in $(seq 1 60); do
    curl -sf -m 1 "http://127.0.0.1:$port/readyz" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "the api did not become ready — see $RUN_DIR/api.log" >&2
  return 1
}

adapter_stop_api() { adapter_stop_pid "$RUN_DIR/api.pid"; }

# adapter_cleanup — the EXIT trap: stop the API and every fake this run started.
adapter_cleanup() {
  adapter_stop_pid "$RUN_DIR/api.pid"
  local pidfile
  for pidfile in "$RUN_DIR"/*.pid; do
    [ -e "$pidfile" ] && adapter_stop_pid "$pidfile"
  done
  return 0
}
