# Probes and readiness

**What it is.** Two Kubernetes-style probes (LOB-21). `GET /livez` answers "is this process alive"
and depends on nothing — a liveness probe that failed because the database was down would have
Kubernetes restart a healthy pod and turn an outage into a crash loop. `GET /readyz` answers "can
this process serve a session right now" and is a live check: Postgres answers a round-trip, the
migration ledger holds every migration the control plane needs, and the real columns of `sessions`,
`session_activity`, `repos`, and `commits` are selectable. It answers 503 with a body naming each
check and what failed.

**How a user reaches it.** `curl localhost:9000/livez`; a cluster's `livenessProbe` and
`readinessProbe` point at them. `up.sh` waits on `/readyz`, because the server binds before its
migrations are applied.

**How the skill drives it.** `drive.ts` fetches both routes and asserts `/livez` is 200 with
`{"status":"ok"}`, and `/readyz` is 200 with every check `ok`. `degraded.sh` (see
[lifecycle.md](lifecycle.md)) drives the failing branch with Postgres stopped: `/livez` stays 200
while `/readyz` is 503 and names `postgres` — all three checks fail, because with no database there
is no ledger and no schema either.

**Why a live check.** A readiness flag cached at boot answers the wrong question: a pod whose
database went away after boot is not ready, and one whose database came back is. `degraded.sh`
proves the second half — the same process, no restart, `/readyz` green again.

**What it does not prove.** Nothing about a cluster: no probe is configured anywhere yet (M7 owns
the manifests). Nothing about a _partially_ applied migration: the middle branch is named in the
body, not driven (see the feature map).
