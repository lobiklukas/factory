#!/usr/bin/env bash
# Prove the spec document across a process boundary (LOB-72, part 1 of LOB-46).
#
# The claim: a spec whose gaps are declared `[]` round-trips and reads the same after a reopen, and a
# spec with no `gaps` field is refused with a typed error naming the field — `gaps: []` and `gaps`
# absent are two answers. Two driver processes in sequence on the run's database: `write` commits,
# `reopen` reads. The second one is a fresh process on purpose, so the answer can only come from the
# log.
#
# The script starts no API and no fake, binds no port, and leaves nothing running: the driver builds
# the harness in-process (`openSession` on `PostgresStorage`), as `./pr-once.sh` builds the service.
#
#   ./spec.sh
#
# Env: DATABASE_URL (required), EVIDENCE_DIR.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RUN_DIR="$ROOT/.verify/run/spec"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}/api"
STATE="$RUN_DIR/log-id"
DRIVER="$ROOT/.pi/skills/verify-api/spec.ts"

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR"
# A previous run's evidence would answer the pid check for a phase that never ran this time.
rm -f "$STATE" "$EVIDENCE_DIR/spec-write.json" "$EVIDENCE_DIR/spec-reopen.json"

source "$ROOT/.pi/skills/lib/postgres.sh"
ensure_postgres || exit 1

driver_env=( env
  SPEC_STATE="$STATE"
  SPEC_CWD="$RUN_DIR/cwd"
  EVIDENCE_DIR="$EVIDENCE_DIR"
  DATABASE_URL="${DATABASE_URL:?spec needs DATABASE_URL from the run}" )

failed=0

"${driver_env[@]}" MODE=write bun "$DRIVER" 2>&1 | tee "$RUN_DIR/write.log"
WRITE_RC=${PIPESTATUS[0]}
[ "$WRITE_RC" = "0" ] || failed=1

if [ "$WRITE_RC" = "0" ] && [ -s "$STATE" ]; then
  "${driver_env[@]}" MODE=reopen bun "$DRIVER" 2>&1 | tee "$RUN_DIR/reopen.log"
  REOPEN_RC=${PIPESTATUS[0]}
else
  echo "the write phase failed or left no log id — reopen not run; see $RUN_DIR/write.log" >&2
  REOPEN_RC=1
fi
[ "$REOPEN_RC" = "0" ] || failed=1

# The two phases ran in two processes: the pids are in each phase's evidence.
WRITE_PID="$(bun -e 'console.log((await Bun.file(process.argv[1]).json()).pid)' "$EVIDENCE_DIR/spec-write.json" 2>/dev/null || echo "?")"
REOPEN_PID="$(bun -e 'console.log((await Bun.file(process.argv[1]).json()).pid)' "$EVIDENCE_DIR/spec-reopen.json" 2>/dev/null || echo "?")"
SEPARATE=1
if [ "$WRITE_PID" != "?" ] && [ "$REOPEN_PID" != "?" ] && [ "$WRITE_PID" != "$REOPEN_PID" ]; then
  SEPARATE=0
fi
[ "$SEPARATE" = "0" ] || failed=1
printf '%s  %-62s %s\n' "$([ "$SEPARATE" = "0" ] && echo PASS || echo FAIL)" \
  "the reopen ran in a different process from the write" "write=$WRITE_PID reopen=$REOPEN_PID"

{
  printf '{\n'
  printf '  "logId": "%s",\n' "$(cat "$STATE" 2>/dev/null)"
  printf '  "write": {"exit": %s, "pid": "%s"},\n' "$WRITE_RC" "$WRITE_PID"
  printf '  "reopen": {"exit": %s, "pid": "%s"}\n' "$REOPEN_RC" "$REOPEN_PID"
  printf '}\n'
} > "$EVIDENCE_DIR/spec-process.json"

echo
if [ "$failed" -eq 0 ]; then
  echo "spec: all checks passed — evidence in $EVIDENCE_DIR"
else
  echo "spec: FAILURES — see $EVIDENCE_DIR/spec-write.json and spec-reopen.json" >&2
fi
exit "$failed"
