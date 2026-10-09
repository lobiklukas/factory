#!/usr/bin/env bash
# Claims for parallel ralph workers (see .pi/ralph/README.md, "Parallel workers").
#
#   claim.sh claim <id>        exit 0: yours (new, already yours, or taken over from a stale claim); exit 1: another worker holds it
#   claim.sh release <id>      drop your claim (`--any`: drop it whoever holds it)
#   claim.sh list              one line per claim: <id> worker=<n> age=<seconds>
#
# <id> is an issue id (`LOB-95`): the unit of work, and the key for a ralph PR being fixed too (the issue its branch
# `ralph/LOB-95` belongs to). A claim is a directory under $RALPH_SHARED/claims created with `mkdir`, which is
# atomic, so two workers never both win. It goes stale after RALPH_CLAIM_TTL seconds (default 3 h) so a killed
# worker cannot hold an issue forever; the driver also releases a worker's claims for issues without an open PR
# at the end of each iteration, which also frees an issue once its PR merges.
set -euo pipefail

SHARED="${RALPH_SHARED:?RALPH_SHARED must name the directory the workers share}"
WORKER="${RALPH_WORKER:-1}"
TTL="${RALPH_CLAIM_TTL:-10800}"
DIR="$SHARED/claims"
mkdir -p "$DIR"

now() { date +%s; }
valid() { case "$1" in ''|*[!A-Za-z0-9._-]*) echo "claim.sh: bad id '$1'" >&2; exit 64 ;; esac; }
write() { echo "$WORKER" >"$1/worker"; now >"$1/at"; }

case "${1:-}" in
  claim)
    id="${2:-}"; valid "$id"; d="$DIR/$id"
    if mkdir "$d" 2>/dev/null; then write "$d"; exit 0; fi
    owner="$(cat "$d/worker" 2>/dev/null || echo '?')"; at="$(cat "$d/at" 2>/dev/null || echo 0)"
    if [ "$owner" = "$WORKER" ]; then now >"$d/at"; exit 0; fi
    if [ $(( $(now) - at )) -ge "$TTL" ]; then
      # A stale claim is moved aside, not deleted in place: of two workers that both see it stale, the second
      # `mv` finds nothing and the second `mkdir` loses, so exactly one takes it over.
      if mv "$d" "$d.stale.$$" 2>/dev/null && mkdir "$d" 2>/dev/null; then
        rm -rf "$d.stale.$$"; write "$d"; exit 0
      fi
    fi
    echo "$id is claimed by worker $owner ($(( $(now) - at ))s ago): take another issue" >&2
    exit 1 ;;
  release)
    shift; any=0; [ "${1:-}" = "--any" ] && { any=1; shift; }
    id="${1:-}"; valid "$id"; d="$DIR/$id"
    [ -d "$d" ] || exit 0
    if [ "$any" = 1 ] || [ "$(cat "$d/worker" 2>/dev/null)" = "$WORKER" ]; then rm -rf "$d"; fi ;;
  list)
    for d in "$DIR"/*/; do
      [ -d "$d" ] || continue
      printf '%s worker=%s age=%s\n' "$(basename "$d")" "$(cat "$d/worker" 2>/dev/null || echo '?')" "$(( $(now) - $(cat "$d/at" 2>/dev/null || echo 0) ))"
    done ;;
  *) echo "usage: claim.sh claim <id> | release [--any] <id> | list" >&2; exit 64 ;;
esac
