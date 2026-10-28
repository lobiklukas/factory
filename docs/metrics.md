# Metrics

What the control plane (`apps/api`) exports as metrics, and how to receive them. The definitions
are `packages/core/src/metrics.ts`; this page is the operator's copy and changes with it.

## Turning it on

Metrics leave the process over OTLP/HTTP (JSON) to any OpenTelemetry-compatible receiver — an
OpenTelemetry Collector's `otlp` receiver, or a backend's OTLP intake. Off unless the endpoint is
set; the variable names are OpenTelemetry's own.

| Variable                              | Meaning                                                                                                                                                                                                                                                              | Default          |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | The full URL metrics are posted to, used as given (a collector's is `http://host:4318/v1/metrics`). A malformed URL, or one whose scheme is not `http:` or `https:` (a scheme-less `localhost:4318/v1/metrics` parses with protocol `localhost:`), refuses the boot. | unset: no export |
| `OTEL_METRIC_EXPORT_INTERVAL`         | Milliseconds between exports; a positive integer. The last export is made on shutdown.                                                                                                                                                                               | `60000`          |
| `OTEL_SERVICE_NAME`                   | The resource's `service.name`.                                                                                                                                                                                                                                       | `factory-api`    |

Temporality is **cumulative**: every export carries totals since the process started. A restart
starts the totals again, which a collector reads as a counter reset.

**Not motel.** `MOTEL_URL` exports logs and traces to motel (`bun run motel`), which ingests nothing
else; metrics go to the endpoint above, never to motel.

The CLI (`apps/cli`) exports no metrics: it hosts no session, so none of the set below happens in its
process.

## The metric set

Names are OpenTelemetry-style (dotted); a Prometheus backend translates them (`factory.refusals` →
`factory_refusals_total`). Units are UCUM, as the OpenTelemetry semantic conventions write them.
Effect also sends each metric's unit as a `unit` point attribute beside the metric's own `unit`
field.

| Metric                    | Instrument              | Unit        | Attributes                                                                | What it counts                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | ----------------------- | ----------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `factory.session.creates` | counter (monotonic sum) | `{session}` | `origin`: `create`, `fork`, `replay`                                      | Sessions created. A `createSession` the request-id dedupe answers with an existing session is not counted; a fork or replay refused before it exists is not counted.                                                                                                                                                                |
| `factory.session.active`  | gauge                   | `{session}` | —                                                                         | Sessions this process owns right now: an open harness and a held log, from the open that creates or wakes a session to the release that closes it (idle sweep, workspace release, shutdown). A session nobody owns is in the database, not here, so the sum over replicas is the fleet's.                                           |
| `factory.run.duration`    | histogram               | `s`         | —                                                                         | Wall time of a run: from the session turning busy to idle again, as its owner saw it. Buckets: 0.1, 0.5, 1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600. A run cut short by its owner's release (workspace release, shutdown) is not recorded; one resumed after a restart is timed from the reopen.                                   |
| `factory.refusals`        | counter (monotonic sum) | `{refusal}` | `reason`: `message_too_long`, `busy`, `released`, `budget`, `at_capacity` | Requests the factory understood and declined: a message over the length cap, a `whenBusy: "reject"` message to a running session, a start on a session whose workspace was released, a model request stopped by the session's budget, and a request that would open one more session than `SESSION_MAX_CONCURRENT` allows (LOB-70). |

A metric appears in an export once it has been updated in that process: a fresh process with no
session yet sends none of them.

## How it is proven

`apps/api/src/observability/OtlpMetrics.test.ts` points the real exporter at an in-process OTLP/HTTP
receiver and creates a session; `packages/core/src/metrics.test.ts` moves each metric through the
service path that owns it; `.pi/skills/verify-api/metrics.sh` boots the API against a loopback
receiver (`features/metrics.md`). What a receiver of our own cannot prove — that a real collector
accepts the body, what a backend does with the names — is the OTLP row of
`docs/testing-third-parties.md`.

Admission control's refusal (LOB-70) is `factory.refusals{reason="at_capacity"}`; with
`factory.session.active` beside it, an operator sees both how close the process runs to
`SESSION_MAX_CONCURRENT` and how often it said no. Only a request's refusal counts: a reopen the
server makes on its own behalf (a replay's comparison commit) is refused at capacity without being
counted, and a boot's resume of a run or mission is never refused. The board's queue depth (LOB-71)
joins this set when it lands.

## Outcome metrics (LOB-44)

The metrics above are what the process is doing now. **Outcome metrics** ask whether the factory is
accelerating delivery, over a window, and are not exported: they are one read of the index tables,
`getOutcomes` over RPC and `factory outcomes` on the CLI (`--since`, `--until`, `--repo`, `--json`).
The definitions are `packages/core/src/outcomes.ts`'s module comment; `outcomes.test.ts` proves each
one against a hand-computed oracle over a seeded fixture.

**Every value states its window `[since, until)`, its denominator (a count and what it counts) and
its source.** A share or a median of an empty population is `null`, never `0`. The default window is
the thirty days before now.

| Metric            | Values                                                                                  | Denominator                                                  | Source                                                                     |
| ----------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `lead_time`       | `card.median`, `card.mean`: card `created` → first move into `done`                     | cards that first reached `done` in the window                | `task_events`                                                              |
|                   | `card.factory_share`: the union of the card's run intervals over its summed lead time   | the same cards, time-weighted                                | `task_runs.started_at` → `finished_at` (else the session's last activity)  |
|                   | `delegation.median`, `delegation.mean`: Linear delegation → first merge (re-runs too)   | Linear issues whose delegation first merged in the window    | `sessions.request_id`, `forked_from`, `pr_merged_at`                       |
| `cycle_time`      | `card.median`, `card.mean`: first move out of the filed column → first move into `done` | cards that reached `done` in the window after moving         | `task_events`                                                              |
| `defect_pressure` | `merges.reverted`, `merges.followed_up`, `follow_up_sessions`, `rate`                   | PRs the factory opened that merged in the window             | `sessions.pr_merged_at`, `pr_reverted_at`, `forked_from`, `task_runs`      |
| `recovery`        | `reruns.recovered`, `reruns.median_to_merge`; `approvals.approved_rate`, `denied_rate`  | re-runs created in the window; decisions taken in the window | `sessions.forked_from`, `pr_merged_at`; `session_approvals`                |
| `adoption`        | `sessions.<trigger>` (linear … direct); `actors.repeat`                                 | sessions created in the window; people who started one in it | `sessions.request_id`, `task_runs`, `sessions.actor`                       |
| `cost`            | `total`, `per_session`                                                                  | sessions created in the window                               | `session_activity.cost_total` (LOB-17), so it reconciles with `factory ls` |

A merge is the factory's own record, not a read of GitHub: the `pull_request` webhook commits
`factory.merge` to each session whose PR merged, and to the sessions of a PR a later merged PR says it
reverts (`Reverts owner/repo#N`, GitHub's revert wording); `sessions.pr_merged_at` and
`pr_reverted_at` are its index, refolded by `rebuildIndexes`. A merge before this was recorded is in
no number. A run's end (`task_runs.finished_at`) is written where its session goes idle.

A card-mode rule's card (LOB-254) carries its source into the numbers: its runs count under that
source in `adoption` (the card's `created` event names `trigger:<source>`), and a Linear card's
delegation runs from the card's filing to the first merge of its runs. A card that went from its
filed column straight into `done` has a lead time and no cycle time.

Known limits:

- **`card.factory_share` does not fully survive a rebuild from scratch.** `task_runs.finished_at` is
  in no log (docs/design.md D7, "As built (LOB-44)"): a run row `rebuildIndexes` re-creates starts at
  its session's first commit and reads as ending at the session's last activity, which a later
  commit stretches, so the share is an upper bound for those runs.
- **The read scans every session created before `until`**, in the repo when one is named: a merge,
  revert or follow-up in the window can belong to a session created long before it. Its cost grows
  with the deployment's history, not with the window; a bound to the sessions related to the window
  is the next step if it shows up in the read's latency.

Not here yet: the share of all merged PRs the factory authored and of issues it closed (their
denominators are outside the factory's records), a policy `block`'s refusal rate (indexed nowhere),
emission over OTLP, and a board view.
