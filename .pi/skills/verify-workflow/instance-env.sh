#!/usr/bin/env bash
# The environment the workflow instance's API runs under (LOB-40), rebuilt from what `up.sh` recorded
# in .verify/run/workflow — so `up.sh` and `restart-api.sh` start the API identically, and a restart
# mid-run serves the same label mapping, Linear, forge, gate and model as the process it replaced.
#
# Sourced, not run, with `ROOT` and `WF_DIR` set and `WORKFLOW_BASE_URL` naming the base database
# URL (the scratch database is on its server). Faux values are the fakes' own and are recorded on
# disk; live credentials are never recorded — they are read from the owner's shell, as exported.

# One scalar field of instance.json, read as JSON: `up.sh` writes the file with JSON.stringify, so a
# value may hold a comma or a quote — APPROVAL_REQUIRED is a comma-separated list — and still reads
# back whole. Prints nothing for a field the file does not have.
workflow_field() {
  WF_INSTANCE="$WF_DIR/instance.json" WF_FIELD="$1" bun -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.env.WF_INSTANCE, "utf8"))[process.env.WF_FIELD];
    if (value !== undefined && value !== null) console.log(String(value));
  '
}

# Export everything verify-board's `up.sh` hands the API for this instance.
workflow_export_env() {
  local mode slug label
  mode="$(workflow_field mode)"
  slug="$(workflow_field repo)"
  label="$(workflow_field label)"
  export DATABASE_URL="${WORKFLOW_BASE_URL%/*}/$(workflow_field database)"
  export API_PORT WEB_PORT GITHUB_PORT
  API_PORT="$(workflow_field apiPort)"
  WEB_PORT="$(workflow_field webPort)"
  GITHUB_PORT="$(workflow_field githubPort)"
  export SEED_REPO_SLUG="$slug"
  export LINEAR_SESSION_URL_BASE="http://localhost:$WEB_PORT/sessions"
  export APPROVAL_REQUIRED
  APPROVAL_REQUIRED="$(workflow_field approvalRequired)"
  export TRIGGER_RULES
  TRIGGER_RULES="$(LABEL="$label" SLUG="$slug" bun -e 'console.log(JSON.stringify([{ label: process.env.LABEL, repo: process.env.SLUG, baseRef: "main", prompt: "", mode: "card" }]))')"
  if [ "$mode" = "faux" ]; then
    export LINEAR_WEBHOOK_SECRET
    LINEAR_WEBHOOK_SECRET="$(cat "$WF_DIR/linear-secret")"
    export LINEAR_API_URL="http://127.0.0.1:$(workflow_field linearPort)/graphql"
    # The fake checks no key; this one is only ever sent to it.
    export LINEAR_API_KEY="lin_api_verify_workflow_fake"
    export FAUX_EVERY_TURN=true
    export FAUX_COST=0.01
    export BOARD_GITHUB=fake
    export BOARD_GITHUB_TOKEN
    BOARD_GITHUB_TOKEN="$(cat "$WF_DIR/forge-token")"
    export BOARD_GITHUB_GIT_ROOT="$WF_DIR/forge"
    export SEED_REPO_URL="http://127.0.0.1:$(workflow_field gitPort)/$slug.git"
  else
    # Linear and GitHub themselves, with the owner's key, token and secrets as exported.
    unset LINEAR_API_URL FAUX_EVERY_TURN FAUX_COST
    export BOARD_GITHUB=live
    export BOARD_MODEL_BACKEND=anthropic
    export SEED_REPO_URL="https://github.com/$slug.git"
  fi
}
