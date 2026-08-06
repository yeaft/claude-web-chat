# Work Center

Work Center is Yeaft's Agent-level durable task system. Use it when a goal must survive beyond one interactive turn, needs role separation or review, may wait for human input, or must recover after a browser disconnect or Agent restart.

![Work Center showing a WorkItem conversation and its Action graph](/images/work-center.png)

## Mental model

```text
WorkItem
  ├── contract: goal, acceptance criteria, workDir, attachments, memory policy
  ├── Coordinator conversation
  └── Action graph
        └── Run attempts with VP/model/tool snapshots, messages, usage, and evidence
```

- A **WorkItem** is the durable goal and user-facing conversation owner.
- An **Action** is one concrete planned step with an objective, approach, expected result, dependencies, assignment policy, model policy, and workspace policy.
- A **Run** is one fenced attempt to execute an Action. Its identity prevents late or stale output from mutating a newer attempt.
- An **Event** is append-only audit evidence. Current state comes from canonical WorkItem/Action/Run rows, not by replaying UI events.

Work Center is not a Session. It can be created from a Session and keeps that origin link, but its data and lifecycle belong to the selected Agent.

## Create a WorkItem

You can open Work Center from the sidebar or start from a Yeaft Session's composer.

For a new WorkItem, provide:

1. the requirement or goal;
2. the working directory;
3. optional files (supported image, PDF, or text-based attachments);
4. whether to reuse eligible prior memory;
5. whether execution should start immediately.

When created from a Session, the runtime stamps the source Session; model input cannot replace that identity.

## Planning and execution

New WorkItems use AI planning by default:

1. A triage Action inspects the contract and repository context.
2. Triage submits a specific WorkItem type and 1..8 task-specific Actions.
3. The controller validates IDs, dependencies, workspace modes, cycles, and the final acceptance gate.
4. The scheduler claims ready Actions and selects eligible VPs.
5. Each Run executes through the existing Yeaft engine and must submit a structured outcome.
6. Completed evidence unlocks dependent Actions. The WorkItem reaches `done` only after the final gate succeeds.

The graph must have exactly one final acceptance gate: normally a `deliver` Action, or one terminal approved `review` when no delivery operation is needed. Every other Action must be its transitive dependency.

## Concurrency and workspace policy

Work Center can run independent ready Actions concurrently up to `maxConcurrentActions` (default 3, configurable from 1 to 12). Dependencies, workspace policy, and repository state still constrain actual concurrency.

| Workspace mode | Meaning |
| --- | --- |
| `read` | Planner/reviewer contract for an Action that will not mutate files, Git state, services, or external systems. It is not a general OS sandbox. |
| `shared` | Execute against the canonical working directory; mutating shared work is serialized where required. |
| `isolated-write` | Execute independent Git changes in a dedicated worktree. |
| `integrate` | Combine declared isolated-write dependencies; conflicts stop for explicit handling. |

If AI planning uses `isolated-write`, the graph must include exactly one integrate Action that depends on every isolated-write Action, and downstream work consumes the integration result.

## VP and model assignment

An Action can use:

- `auto`: choose a VP by Action capability;
- `pool`: choose from explicit candidates;
- `fixed`: use one configured VP.

Review can require separation from implement/test roles. If no eligible VP or configured model exists, the WorkItem moves to attention instead of silently falling back to an unrelated VP or model.

Model policy can inherit the runtime choice, select primary/fast, or name a specific configured model. Effort is resolved per Action and frozen into the Run snapshot.

## Coordinator and Action conversations

The main WorkItem conversation targets the **Coordinator**. Use it to:

- ask for current status or an explanation;
- guide one or more unfinished Actions;
- change the goal or acceptance criteria and request a replan;
- recover from a Coordinator-visible problem.

The Coordinator has no file, shell, or external side-effect tools. Its structured decision can explain, guide Actions, or replan unfinished work.

You can explicitly target a current Action from the composer when it needs corrected context or an answer. Waiting/failed Action recovery is fenced by Action ID, revision, generation, and current Run state. The Action detail view shows its continuous conversation and an Execution tab with retained request/loop/tool evidence.

## Outcomes and recovery

A Run ends as one of:

- `completed` with concrete evidence and required acceptance checks;
- `waiting` with a human question/reason;
- `retryable` when another attempt is safe and allowed;
- `failed` when automatic continuation is unsafe or exhausted.

Stopping or cancelling closes active execution fences; late tool/model output cannot advance the WorkItem. On Agent restart, stale running Runs become interrupted. Safe Actions may return to ready within their attempt policy; uncertain external side effects require attention instead of blind retry.

## Memory reuse

With `reuseMemory=true`, Work Center can compute three bounded candidate sources:

- scope-bounded full-text recall from the current Agent's memory index;
- structured summary/evidence from completed WorkItems with the same canonical workspace key;
- user-visible transcript excerpts from ordinary Sessions whose persisted workspace resolves to the same canonical path.

Browser-created and legacy items read the Agent user scope. A trusted Session producer may additionally authorize source Session and current VP scopes. Workspace transcript recall is owner-local, verifies the canonical path, excludes the current source Session, and never reads raw tool output.

These are candidates, not a promise that every source enters every prompt. Execution schema v1 appends the runner-computed memory and workspace-Session blocks when non-empty. Schema v2 renders the immutable Mainline context plus a fixed suffix and currently does not append those two precomputed blocks. All recalled content is token-bounded reference context and cannot override the WorkItem contract, Action instruction, tool policy, or completion protocol. `reuseMemory=false` disables the three candidate paths.

## Attachments and evidence

Attachments are persisted with the WorkItem and treated as untrusted reference data. The runtime checks type, size, path stability, and owner boundaries before injection or download.

Execution evidence can include summaries, acceptance checks, file/test references, request usage, loop timing, and retained tool inputs/outputs. The browser loads detailed execution records on demand; large records may be bounded or summarized.

## What Work Center does not promise

- It is not an unrestricted autonomous deployment service.
- `read` workspace policy is not a kernel-level sandbox.
- A completed Action is not enough to mark a WorkItem done; the final acceptance gate must pass.
- A `turn_end` event is not an Action completion. The executor must submit the structured outcome contract.
- Work Center memory never grants authority over the current contract or safety rules.
- Sessions and WorkItems do not share one transcript or one memory owner.

## Related pages

- [Yeaft Sessions and Projects](./yeaft-session.md)
- [Native engine architecture](../tech/yeaft-engine.md)
- [Provider and model configuration](../yeaft-config.md)
- [Internal Work Center domain contract](../../work-center/domain-contract.md)
