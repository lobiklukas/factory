# Interrupt a busy run from the session pane

**What it is.** The composer's **Interrupt this run** button (C8, D9's steer and interrupt), shown
while the session is `busy`. A press sends one `interruptSession`: the server commits an
`interrupted` entry and aborts the root conversation, so the run settles without an answer, its
queued messages are withdrawn, and the session goes `idle`. The turn carries one `interrupted` row
(`data-entry-kind="interrupted"`), the control plane's line rather than the agent's. It is committed
before the abort, so an interrupt that lands mid tool call is followed by that call's aborted result;
one that lands while the model naps, as here, is the turn's last entry.
A later message runs normally. While the call is in flight the button is unavailable (`aria-busy`,
never natively `disabled`) and a second press is dropped. An interrupt that reaches a session whose
run already settled is answered `not_running`, an outcome rather than an error, and the pane shows
a **Nothing to interrupt** toast carrying the server's sentence; it writes nothing.

**How a user reaches it.** Any session page while its header reads `busy`: the square button beside
**Send**.

**How the skill drives it.** `./interrupt.sh` starts its own API (`INTERRUPT_API_PORT`, default
`:9461`) with `MODEL_BACKEND=faux`, `FAUX_COMMAND="echo faux-ok"` and `FAUX_SLEEP_MS` (default
`4000`: the scripted model naps before `bash` and again before it answers), and its own dashboard
(`INTERRUPT_WEB_PORT`, default `:3461`). `interrupt.mjs` creates the session and sends its first
message over the RPC (the sidebar's form is another feature's), opens its page, and presses
Interrupt during the first nap. It then sends a follow-up from the composer, and finally sends a
third message and presses Interrupt with the request held in the browser (`page.route`) until the
server reports the run settled, so the interrupt reaches an idle session.

**What proves it.** The page sent exactly one `interruptSession` per press (counted from the page's
own requests). The header reads `idle` within 5 s of the press. Two naps later neither the page's
transcript nor the log (`getSession`, read from the drive's process) holds `faux-ok`, and the log's
last entry is `interrupted`, matching the one marker row on the page. The follow-up prints
`faux-ok`, answers, and leaves exactly one `interrupted` entry. The held press raises a toast whose
text contains `session <id> is not running: there was no run to interrupt` (the server's message),
and the log still holds one `interrupted` entry. Evidence: `interrupt-busy.png`,
`interrupt-stopped.png`, `interrupt-follow-up.png`, `interrupt-refused.png`, `observed.json`.

**What it does not prove.** Interrupting a running tool call, overlapping interrupts, or a run a
dead process left behind: those are proven at the service — a sleeping `bash` call stopped by two
interrupts at once leaves one marker with the call's aborted result after it, and a full server
(`SESSION_MAX_CONCURRENT`) still stops a paused run and answers an idle session `not_running`
without opening it, in `packages/core/src/SessionService.interrupt.test.ts`; a run the shutdown
interrupted in `packages/core/src/SessionService.test.ts` ("stops a run the shutdown interrupted on
an interrupt"). The stop itself, the marker and `not_running` are unit-proven in
`packages/core/src/SessionService.interrupt.test.ts`; the wire shape
in `apps/api/src/Rpc/Session.test.ts`; the button's markup and one-press guard in
`apps/web/src/components/interrupt-button.test.tsx`; the toast's words in
`apps/web/src/lib/interrupt-view.test.ts`. The CLI is `verify-cli`'s [interrupt.md](../../verify-cli/features/interrupt.md).
