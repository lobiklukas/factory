#!/usr/bin/env bash
# What `--live` needs from the owner's shell (LOB-40), in one place: `up.sh --live`, `doctor.sh --live`
# and `drive.sh --live` all refuse through `live_refusal`, so the three cannot disagree about which
# variable is missing.
#
# Sourced, not run. It reads whether each variable is set and never what it holds: nothing here
# prints, logs or writes a credential.
#
#   LINEAR_API_KEY          the key the write-back posts the PR link and moves the issue with
#   LINEAR_WEBHOOK_SECRET   the signing secret of the Linear webhook that points at the tunnel
#   GITHUB_TOKEN            pushes `factory/<session-id>` and opens the PR on the scratch repo
#   GITHUB_WEBHOOK_SECRET   the secret of the scratch repo's webhook that points at the tunnel
#   WORKFLOW_GITHUB_REPO    the scratch repo, `owner/name`
#   WORKFLOW_PUBLIC_URL     the tunnel's https URL, forwarding to the API's port
#   an Anthropic credential ANTHROPIC_API_KEY, ANTHROPIC_OAUTH_TOKEN or ANTHROPIC_AUTH_TOKEN: the model

# Every variable `--live` requires, in the order the refusal names them.
LIVE_REQUIRED=(
  LINEAR_API_KEY
  LINEAR_WEBHOOK_SECRET
  GITHUB_TOKEN
  GITHUB_WEBHOOK_SECRET
  WORKFLOW_GITHUB_REPO
  WORKFLOW_PUBLIC_URL
)

# The names of the variables `--live` needs and the shell does not set, one per line. Empty when the
# live run has everything it asks for.
live_missing() {
  local name
  for name in "${LIVE_REQUIRED[@]}"; do
    [ -n "${!name:-}" ] || echo "$name"
  done
  if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${ANTHROPIC_OAUTH_TOKEN:-}" ] &&
     [ -z "${ANTHROPIC_AUTH_TOKEN:-}" ]; then
    echo "ANTHROPIC_API_KEY (or ANTHROPIC_OAUTH_TOKEN, or ANTHROPIC_AUTH_TOKEN)"
  fi
  if [ -n "${WORKFLOW_GITHUB_REPO:-}" ] &&
     ! printf '%s' "$WORKFLOW_GITHUB_REPO" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'; then
    echo "WORKFLOW_GITHUB_REPO (set, but not owner/name)"
  fi
}

# Refuse loudly for `$1` (the script's name) when anything is missing: every missing name on its own
# line on stderr, and a non-zero status the caller exits with. Status 0 when nothing is missing.
live_refusal() {
  local missing
  missing="$(live_missing)"
  [ -z "$missing" ] && return 0
  {
    echo "$1 --live refuses: the live run needs these variables, and the shell does not set them:"
    printf '%s\n' "$missing" | sed 's/^/  missing: /'
    echo "see .pi/skills/verify-workflow/SKILL.md (Live run) for what each one is and what to create first"
  } >&2
  return 2
}
