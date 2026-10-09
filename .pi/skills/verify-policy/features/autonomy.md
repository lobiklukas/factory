# Autonomy as data

**What it is.** D11: "Policy is an Effect service and the decision is data, so what may run
unattended is a config surface rather than logic scattered across hooks." Concretely, three things in
`packages/harness/src/policy.ts`:

- `AutonomyConfig` — the deployment's choice: which ref prefixes may be pushed, which hosts may be
  reached, and (optionally) the agent's home directory. `DEFAULT_AUTONOMY` is D11's boundary:
  `refs/heads/factory/**`, and the repository host.
- `AutonomyRules` — that choice resolved for one session's worktree, which is the only fact the
  config does not have.
- `decideToolCall(rules, call)` — pure. Rules and a call in, a `PolicyDecision` out.

**How a user reaches it.** `SessionServiceOptions.autonomy` is the knob. `SessionServiceLive` reads
the `Policy` service (`@repo/harness`) and hands `policy.forWorktree(workspace.path)` to
`openSession`, so the boundary a session runs under comes from the deployment's configuration rather
than from a constant in the harness. `openSession` defaults to `DEFAULT_AUTONOMY` resolved for the
session's cwd, so a session opened without a policy is still policed.

**How the skill drives it.** The API drive proves the _default_ boundary end to end. The
configuration half is proven in `packages/core/src/SessionService.test.ts`: a runtime built with
`autonomy: { pushRefPrefixes: ["refs/heads/sandbox/"] }` runs a session whose command pushes
`refs/heads/factory/ses_1` — allowed by the default, and refused by the narrowed configuration. The
test fails if `SessionServiceLive` stops handing its policy to `openSession`. The default is proven in
`packages/harness/src/policy.hook.test.ts`: a session opened with **no** policy argument refuses both
`git push origin main` and a write outside its cwd, and the write's refusal names the cwd — so the
resolved worktree really is the session's own. That test fails if `openSession` stops installing the
extension when no policy is passed.

**What it does not prove.** That anything _sets_ `options.autonomy` yet. No deployment narrows or
widens it today: `apps/api` builds `SessionServiceLive` without it, so every session runs D11's
default. The two things that will need it are LOB-52 (an approval-asking policy) and LOB-30 (rulesets
as reviewed code), which is why the seam exists now rather than a constant.

The seam's own half — `hook(ToolTask, { beforeTool, afterTool })` — is proven in
`packages/harness/src/policy.seam.test.ts`: the extension registers one hook on the built-in tool task
(`pi.tool`) with both handlers, `afterTool` returns every result shape by reference, and in a real
harness it runs after execution and passes an earlier hook's replacement through untouched. Two facts
worth knowing before LOB-52 builds on it: an identity handler and an absent one produce the same
result value, so registration is asserted rather than behaviourally observed; and pi-durable 1.0.3
settles a **blocked** call before executing it, so `afterTool` never runs for a refusal.
