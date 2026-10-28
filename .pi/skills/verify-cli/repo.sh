#!/usr/bin/env bash
# Drive `factory repo add` / `ls` / `show` in a real tmux terminal (LOB-253): register a checkout,
# update its base ref and keep its path, refuse a path that is not a git work tree and a slug that is
# not one, list the registry, and show a repo a session auto-registered as one no session can cut a
# worktree from — with the command that fixes it.
#
# The registry needs no deployment setting of its own, so this runs against the instance ./up.sh
# started (API_URL, default :9300) with its own tmux server and fixtures under
# .verify/run/cli-repo/. ./drive.sh runs it as a block; it can also be run alone after ./up.sh.
#
# Evidence: .verify/evidence/latest/cli/repo-*.txt (the raw panes) and repo.json.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_PORT:-9300}"
API_URL="${API_URL:-http://localhost:$API_PORT}"
RUN_DIR="$ROOT/.verify/run/cli-repo"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/cli"
SOCK="$RUN_DIR/tmux.sock"
TERM_SESSION="verify-cli-repo"
FACTORY="bun run $ROOT/apps/cli/src/index.ts"
# Slugs of this run's own, so a row an earlier run wrote is never the one asserted on.
RUN_ID="$(date +%s)-$$"
SLUG="acme/verify-cli-repo-$RUN_ID"
REFUSED="acme/verify-cli-refused-$RUN_ID"
AUTO="acme/verify-cli-auto-$RUN_ID"
NESTED_SLUG="acme/verify-cli-nested-$RUN_ID"
UNKNOWN="acme/verify-cli-unknown-$RUN_ID"
# A port nothing listens on: a command that sent a request there would fail as `error: error:`.
DEAD_API="http://127.0.0.1:9"

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR"

failed=0
rows=()
check() { # name, pass-condition (0 = pass), detail
  local ok=false
  [ "$2" = "0" ] && ok=true
  [ "$ok" = "true" ] || failed=1
  rows+=("\"$1\": {\"passed\": $ok, \"detail\": \"$3\"}")
  if [ "$ok" = "true" ]; then
    printf 'PASS  %-60s %s\n' "$1" "$3"
  else
    printf 'FAIL  %-60s %s\n' "$1" "$3"
  fi
}

write_checks() {
  local first=1
  local row
  for row in "${rows[@]}"; do
    [ "$first" -eq 1 ] || printf ',\n'
    first=0
    printf '    %s' "$row"
  done
  printf '\n'
}

if ! curl -sf -m 2 "$API_URL/readyz" >/dev/null 2>&1; then
  echo "no ready API at $API_URL — run ./up.sh first" >&2
  exit 1
fi

# The fixtures: a git work tree that declares its commands, and a plain directory that is not one.
# The plain one is a temp directory rather than one under .verify/: a subdirectory of a checkout is
# inside that checkout's work tree, which the registry accepts (a monorepo package is a valid
# local path), so a directory under this repo would be registered, not refused.
CHECKOUT="$RUN_DIR/checkout"
# `pwd -P` normalizes it (macOS's TMPDIR ends in `/`), so the path the refusal names is this one.
PLAIN="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/verify-cli-plain.XXXXXX")" && pwd -P)"
rm -rf "$CHECKOUT"
mkdir -p "$CHECKOUT/.factory"
if git -C "$PLAIN" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "$PLAIN is inside a git work tree; set TMPDIR to a directory outside one" >&2
  exit 1
fi
git init -q -b main "$CHECKOUT"
printf '{"test": "true"}\n' > "$CHECKOUT/.factory/config"
# A plain directory inside the checkout: accepted, and the answer names the checkout it is inside.
NESTED="$CHECKOUT/packages/nested"
mkdir -p "$NESTED"
# What `git rev-parse --show-toplevel` prints for it: the checkout, symlinks resolved.
CHECKOUT_ROOT="$(cd "$CHECKOUT" && pwd -P)"

t() { tmux -S "$SOCK" "$@"; }
pane() { t capture-pane -p -J -t "$TERM_SESSION" -S -4000 | sed -e 's/[[:space:]]*$//'; }

# Type a command, wait for its sentinel, and leave the output in the pane (drive.sh's pattern: the
# sentinel is a second typed line, so zsh's url-quote-magic cannot swallow it). The pane is cleared
# first, so an assertion cannot match an earlier command's output.
run_cmd() { # marker, command
  local marker="$1" cmd="$2"
  t send-keys -t "$TERM_SESSION" "clear" Enter
  sleep 0.3
  t clear-history -t "$TERM_SESSION" 2>/dev/null || true
  t send-keys -l -t "$TERM_SESSION" "$cmd"
  t send-keys -t "$TERM_SESSION" Enter
  t send-keys -l -t "$TERM_SESSION" "printf '\\n__done_%s:%s\\n' $marker \$?"
  t send-keys -t "$TERM_SESSION" Enter
  for _ in $(seq 1 600); do
    if pane | grep -q "^__done_$marker:[0-9]*$"; then
      sleep 0.2
      return 0
    fi
    sleep 0.1
  done
  return 1
}

exit_code() { pane | grep -o "__done_$1:[0-9]*" | tail -1 | cut -d: -f2; }

# Run a command and keep its pane as evidence: marker, file, command.
drive() {
  run_cmd "$1" "$3" || true
  pane > "$EVIDENCE_DIR/$2"
}

has() { grep -qx -- "$2" "$EVIDENCE_DIR/$1"; }
failed_with() { # marker, file, code
  [ "$(exit_code "$1")" != "0" ] && [ -n "$(exit_code "$1")" ] &&
    grep -q "^error: $3: " "$EVIDENCE_DIR/$2"
}

t kill-server 2>/dev/null || true
rm -f "$SOCK"
t new-session -d -s "$TERM_SESSION" -x 220 -y 60 -c "$ROOT"
trap 't kill-server 2>/dev/null || true; rm -rf "$PLAIN"' EXIT

# --- add: register a checkout, and print what the server answered ---------------------------------
drive add repo-add.txt "$FACTORY repo add $SLUG --path $CHECKOUT --base-ref main --api $API_URL"
check "repo add exits 0" "$([ "$(exit_code add)" = "0" ] && echo 0 || echo 1)" "exit=$(exit_code add)"
check "repo add prints the repo, path and base ref" \
  "$(has repo-add.txt "repo        $SLUG" && has repo-add.txt "path        $CHECKOUT" &&
    has repo-add.txt "base-ref    main" && echo 0 || echo 1)" \
  "repo=$SLUG"
check "repo add names the work tree sessions are cut from" \
  "$(has repo-add.txt "work-tree   $CHECKOUT_ROOT" && echo 0 || echo 1)" \
  "work-tree=$CHECKOUT_ROOT"
check "repo add says .factory/config was found" \
  "$(has repo-add.txt "config      .factory/config found" && has repo-add.txt "state       ready" && echo 0 || echo 1)" \
  "config found, ready"

# --- add again: a new base ref updates the row and keeps the path ---------------------------------
drive rebase repo-add-rebase.txt "$FACTORY repo add $SLUG --base-ref trunk --api $API_URL"
check "a second add with only --base-ref exits 0" "$([ "$(exit_code rebase)" = "0" ] && echo 0 || echo 1)" "exit=$(exit_code rebase)"
check "the second add updates the base ref and keeps the path" \
  "$(has repo-add-rebase.txt "base-ref    trunk" && has repo-add-rebase.txt "path        $CHECKOUT" && echo 0 || echo 1)" \
  "base-ref=trunk path kept"

# --- a path inside a checkout: accepted, and the enclosing work tree is named ----------------------
drive nested repo-add-nested.txt "$FACTORY repo add $NESTED_SLUG --path $NESTED --api $API_URL"
check "a path inside a checkout is ready and names the enclosing work tree" \
  "$([ "$(exit_code nested)" = "0" ] && has repo-add-nested.txt "path        $NESTED" &&
    has repo-add-nested.txt "work-tree   $CHECKOUT_ROOT" && has repo-add-nested.txt "state       ready" &&
    echo 0 || echo 1)" \
  "path=$NESTED work-tree=$CHECKOUT_ROOT"

# --- refusals: a path that is not a work tree, and a slug that is not one -------------------------
drive notgit repo-add-not-git.txt "$FACTORY repo add $REFUSED --path $PLAIN --api $API_URL"
check "a path that is not a git work tree is invalid_input, non-zero" \
  "$(failed_with notgit repo-add-not-git.txt invalid_input && echo 0 || echo 1)" \
  "exit=$(exit_code notgit)"
check "the refusal names the path" \
  "$(grep -qF "$PLAIN is not a git work tree" "$EVIDENCE_DIR/repo-add-not-git.txt" && echo 0 || echo 1)" \
  "path named"
drive refusedshow repo-show-refused.txt "$FACTORY repo show $REFUSED --api $API_URL"
check "and nothing was written: the slug is still repo_not_found" \
  "$(failed_with refusedshow repo-show-refused.txt repo_not_found && echo 0 || echo 1)" \
  "exit=$(exit_code refusedshow)"

drive badslug repo-add-bad-slug.txt "$FACTORY repo add Acme/Upper --path $CHECKOUT --api $DEAD_API"
check "a bad slug is invalid_input before any request" \
  "$(failed_with badslug repo-add-bad-slug.txt invalid_input &&
    grep -qF 'is not a repository (owner/name)' "$EVIDENCE_DIR/repo-add-bad-slug.txt" && echo 0 || echo 1)" \
  "exit=$(exit_code badslug), --api $DEAD_API never asked"

# --- a repo a session auto-registered: no URL, no checkout, and the remedy -------------------------
drive auto repo-run-auto.txt "$FACTORY run \"verify-cli repo probe\" --repo $AUTO --api $API_URL"
check "a session names a repo nobody registered" \
  "$([ "$(exit_code auto)" = "0" ] && grep -q "^repo $AUTO" "$EVIDENCE_DIR/repo-run-auto.txt" && echo 0 || echo 1)" \
  "exit=$(exit_code auto)"
drive autoshow repo-show-auto.txt "$FACTORY repo show $AUTO --api $API_URL"
check "repo show says no clone URL / no local checkout" \
  "$([ "$(exit_code autoshow)" = "0" ] &&
    has repo-show-auto.txt "state       no clone URL / no local checkout" &&
    has repo-show-auto.txt "path        none" && has repo-show-auto.txt "url         none" && echo 0 || echo 1)" \
  "exit=$(exit_code autoshow)"
check "and prints the remedy" \
  "$(has repo-show-auto.txt "remedy      factory repo add $AUTO --path <dir>" && echo 0 || echo 1)" \
  "factory repo add $AUTO --path <dir>"

# --- ls: every repo, its path (or none), base ref and registered-at -------------------------------
drive ls repo-ls.txt "$FACTORY repo ls --api $API_URL"
REG_ROW="$(awk -v slug="$SLUG" '$1 == slug { print; exit }' "$EVIDENCE_DIR/repo-ls.txt")"
AUTO_ROW="$(awk -v slug="$AUTO" '$1 == slug { print; exit }' "$EVIDENCE_DIR/repo-ls.txt")"
# The terminal expands the tabs between columns, so the pane is read as whitespace-split fields.
check "repo ls exits 0 with its header" \
  "$([ "$(exit_code ls)" = "0" ] &&
    grep -qE '^repo[[:space:]]+path[[:space:]]+base-ref[[:space:]]+registered-at[[:space:]]+config[[:space:]]+url[[:space:]]+state$' \
      "$EVIDENCE_DIR/repo-ls.txt" && echo 0 || echo 1)" \
  "exit=$(exit_code ls)"
check "repo ls lists the registered repo with its path, base ref and registered-at" \
  "$(echo "$REG_ROW" | awk -v p="$CHECKOUT" '$2 == p && $3 == "trunk" && $4 ~ /^[0-9]{4}-[0-9]{2}-[0-9]{2}T/ && $5 == "yes" { ok = 1 } END { exit !ok }' && echo 0 || echo 1)" \
  "row=$(echo "$REG_ROW" | cut -c1-120)"
check "repo ls lists the auto-registered repo with none and the remedy" \
  "$(echo "$AUTO_ROW" | awk '$2 == "none" && $3 == "main" && $6 == "none" { ok = 1 } END { exit !ok }' &&
    echo "$AUTO_ROW" | grep -qF "no clone URL / no local checkout (factory repo add $AUTO --path <dir>)" && echo 0 || echo 1)" \
  "row=$(echo "$AUTO_ROW" | cut -c1-120)"
# Piped rather than in the pane: what a script reads, where the separator is the tab itself.
$FACTORY repo ls --api "$API_URL" > "$EVIDENCE_DIR/repo-ls-piped.txt" 2>&1
PIPED_PATH="$(awk -F'\t' -v slug="$SLUG" '$1 == slug { print $2; exit }' "$EVIDENCE_DIR/repo-ls-piped.txt")"
PIPED_HEADER="$(head -1 "$EVIDENCE_DIR/repo-ls-piped.txt")"
check "piped, repo ls separates its columns with tabs" \
  "$([ "$PIPED_HEADER" = "$(printf 'repo\tpath\tbase-ref\tregistered-at\tconfig\turl\tstate')" ] &&
    [ "$PIPED_PATH" = "$CHECKOUT" ] && echo 0 || echo 1)" \
  "path=$PIPED_PATH"
check "repo ls does not list the refused registration" \
  "$(grep -qE "^$REFUSED[[:space:]]" "$EVIDENCE_DIR/repo-ls.txt" && echo 1 || echo 0)" \
  "absent"

# --- show: an unknown slug is a typed refusal -----------------------------------------------------
drive unknown repo-show-unknown.txt "$FACTORY repo show $UNKNOWN --api $API_URL"
check "repo show for an unknown slug is repo_not_found, non-zero" \
  "$(failed_with unknown repo-show-unknown.txt repo_not_found && echo 0 || echo 1)" \
  "exit=$(exit_code unknown)"

{
  printf '{\n'
  printf '  "apiUrl": "%s",\n' "$API_URL"
  printf '  "repo": "%s",\n' "$SLUG"
  printf '  "autoRegistered": "%s",\n' "$AUTO"
  printf '  "checks": {\n'
  write_checks
  printf '  }\n}\n'
} > "$EVIDENCE_DIR/repo.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "repo: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "repo: FAILURES — see $EVIDENCE_DIR/repo.json" >&2
fi
exit "$failed"
