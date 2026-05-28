# Refactor Plan

This plan documents the AI SDK + LangGraph + OpenCode refactor and the ownership boundaries that should stay true as the codebase evolves.

## Refactor Goal

The implementation should keep:

- one provider config compiled into both AI SDK and OpenCode runtime views
- AI SDK as the model layer for PRD, review, context, routing, and controlled platform tools
- LangGraph as the durable workflow runtime
- OpenCode as the only default coding executor
- CodeZero persistence, events, artifacts, sandboxing, GitHub integration, and quality gates kept as product-owned services

## Invariants

Do not break these contracts:

- One GitHub issue maps to one task, one persistent sandbox, one branch, and one PR.
- PRD approval resumes the same task and sandbox.
- PR feedback updates the same PR branch.
- Implementation does not use JSON patch, write-file actions, or self-built edit loops.
- API keys stay in environment variables.
- User-facing copy says CodeZero, not OpenCode, unless documenting local setup.

## Work Package 1: Canonical Provider Runtime

Create a provider runtime module that owns the single source of truth.

Suggested shape:

```text
packages/model-runtime/
  src/config.ts
  src/ai-sdk-registry.ts
  src/model-router.ts
  src/opencode-config.ts
  src/structured-agent.ts
```

Tasks:

- Move provider selection out of `packages/workflows/src/agent-factory.ts`.
- Replace `OpenAICompatibleProvider` with AI SDK registry-backed calls.
- Add `generateStructuredAgentOutput(agent, schema, context)`.
- Keep zod schemas as the authority for PRD and review outputs.
- Move `buildOpenCodeProviderConfig` out of `coding-executor.ts` into the new provider runtime.
- Add tests that prove one provider config can create both an AI SDK model and an OpenCode config artifact.

Acceptance:

- PRD and review agents no longer call hand-written `/chat/completions`.
- Split config files are removed; runtime reads only `config/codezero.yaml`.
- OpenCode config generation keeps raw API keys out of artifacts.

## Work Package 2: LangGraph State Model

Add a graph state package while keeping workflow step helpers reusable.

Suggested shape:

```text
packages/workflow-graph/
  src/state.ts
  src/events.ts
  src/nodes/
  src/graph.ts
  src/checkpointer.ts
```

Tasks:

- Define `CodeZeroGraphState`.
- Map current `Task` fields into graph state.
- Use `task.id` as LangGraph `thread_id`.
- Use Postgres checkpointer for production and memory/sqlite checkpointer for local tests.
- Add event helpers that emit existing `TaskEvent` records from graph callbacks.

Acceptance:

- A test can create graph state from an existing task and write/read a checkpoint.
- Graph state can be resumed by task id.
- Event output remains compatible with the current Run Console.

## Work Package 3: Wrap Existing Workflow Methods as Nodes

Do not rewrite business behavior first. Wrap current workflow methods behind node functions.

Initial node mapping:

```text
prepare_sandbox                 -> existing prepareSandbox behavior
build_repository_intelligence   -> existing codegraph/navigation/memory/context behavior
draft_prd                       -> existing PRD agent behavior through AI SDK
run_opencode_executor           -> existing coding executor behavior
run_quality_gates               -> existing verification behavior
run_review_agent                -> existing review behavior through AI SDK
create_or_update_pr             -> existing PR creation/update behavior
```

Tasks:

- Extract private methods from `IssueWorkflowRunner` into reusable services where needed.
- Keep `IssueWorkflowRunner` as reusable workflow step services while callers enter through `packages/workflow-graph`.
- Preserve existing artifacts and event names.

Acceptance:

- Existing tests can be migrated one area at a time.
- No product behavior changes are required for the first graph-backed run.

## Work Package 4: Human Interrupts

Move human wait states into LangGraph interrupts.

Interrupt points:

- PRD review required.
- Policy approval required.
- Manual retry or unblock.
- PR feedback received.

Tasks:

- Convert dashboard PRD approval into graph resume.
- Convert GitHub `approve prd` comment into graph resume.
- Convert PR feedback sync into graph resume with feedback payload.
- Store interrupt metadata in task events and artifacts.

Acceptance:

- Approval does not enqueue a duplicate full workflow.
- Feedback resumes the same task thread, sandbox, branch, and PR.

## Work Package 5: Repair Loop Edges

Move the self-check loop into graph conditional edges.

Edges:

- quality gate failure, repairable -> `run_opencode_executor`
- quality gate failure, environmental -> `blocked`
- review failure, repairable -> `run_opencode_executor`
- review failure, repeated/no progress -> `blocked`
- review approved -> `create_or_update_pr`

Tasks:

- Put repair budget in graph state.
- Store each executor attempt as an artifact group.
- Preserve checkpoint before each OpenCode run.
- Restore pre-run diff when executor exits non-zero or produces no diff.

Acceptance:

- The graph can resume from the last completed node after worker restart.
- Successful nodes are not rerun unnecessarily after checkpoint restore.

## Work Package 6: Worker Cutover

BullMQ remains the job trigger, not the workflow brain.

Tasks:

- Change worker job from `run entire IssueWorkflowRunner` to `startOrResumeGraph(taskId)`.
- Keep repository concurrency checks before graph invocation.
- Add graph-run id and thread id to job metadata.
- Make retries resume graph state instead of starting from scratch.

Acceptance:

- Restarting the worker during implementation resumes the graph rather than rebuilding the entire task.
- Deferred repository capacity jobs remain compatible with current queue behavior.

## Work Package 7: Cleanup Old Runtime Paths

Remove obsolete abstractions after graph-backed workflow passes tests.

Remove or shrink:

- manual provider probing outside AI SDK
- legacy JSON action implementation loop
- workflow-specific model selection helpers
- duplicated provider-to-OpenCode config logic
- docs or comments that describe Tool Gateway as the coding edit loop

Keep:

- Tool Gateway for controlled platform tools
- OpenCode executor
- sandbox manager
- verification service
- persistence repositories
- GitHub service
- memory proposal flow
- codebase intelligence services

## Validation Checklist

Before calling the refactor done:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- golden issue eval still runs
- PRD approval resumes the same thread
- OpenCode implementation produces events and diff artifacts
- quality gate failure loops back into OpenCode with feedback
- review failure loops back into OpenCode with feedback
- PR feedback updates the same PR
- no generated artifact stores raw API keys
- README and docs only describe the AI SDK + LangGraph + OpenCode architecture

## Suggested File Ownership

```text
packages/model-runtime/       AI SDK registry, model router, OpenCode config compiler
packages/workflow-graph/      LangGraph state, nodes, edges, checkpointer, callbacks
packages/workflows/           reusable workflow step helpers and OpenCode executor integration
packages/tool-gateway/        controlled platform tools only
packages/sandbox/             sandbox and process execution primitives
packages/verification/        quality gates and screenshots
apps/worker/                  graph start/resume trigger
apps/api/                     dashboard/GitHub actions that resume graph interrupts
```
