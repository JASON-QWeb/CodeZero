# CodeZero Core Product Flow

This document is the canonical product contract for CodeZero. Keep it current before changing workflow behavior. It is intentionally explicit so future agents can recover the product logic after context compaction.

## Product Intent

CodeZero is a GitHub Issue/PR automation product. A user should be able to mention the bot in an issue, review the bot's planning document, let the bot implement in the same isolated sandbox, and then review a pull request that already contains self-check results and screenshot artifact references. The user decides when to merge unless auto-merge is explicitly configured later.

## Main Loop

1. A GitHub issue or issue comment triggers the configured repository mention, for example `@codeZero`.
2. CodeZero asynchronously imports the issue and creates one task for that repository/issue pair.
3. CodeZero creates or reuses the task sandbox and issue branch immediately. This sandbox is the task's persistent workspace until the PR is accepted or the task is cancelled.
4. CodeZero loads repository-level intelligence and updates issue-specific context inside that sandbox:
   - CodeGraph database and task context.
   - Repo Navigation Graph and route.
   - Understand-Anything knowledge graph, when generated for the repository.
   - Repository project rules, testing guide, and `.agent/skills/*/SKILL.md`.
   - Approved memories from previous tasks.
5. The planning agent generates one planning document from the issue and code context. The document includes product intent, acceptance criteria, risks, complexity, files to read/change, tests, commands, and risk notes.
6. CodeZero comments that planning document back to the GitHub issue.
7. If the plan is low-risk, CodeZero auto-approves it and continues. If it is complex, risky, or uncertain, CodeZero waits for human approval from the dashboard or an issue comment such as `@codeZero approve prd`.
8. Approval resumes the same task and the same sandbox. It must not create a duplicate task, duplicate branch, or feedback-specific sandbox.
9. CodeZero invokes its internal coding executor in the persistent task sandbox. The default executor is a CLI coding agent configured from the user's CodeZero model/API settings, so it can read files, edit code, run local commands, and repair failures directly in the isolated worktree. The user-facing product remains CodeZero; the executor implementation is an internal runtime detail.
10. CodeZero runs self-checks before creating or updating a PR:
    - Repository setup gate, when configured, to start local dependencies such as databases, caches, migrations, or seeded services.
    - Review agent.
    - Unit tests.
    - Typecheck.
    - Lint.
    - Build.
    - Frontend screenshot verification when configured.
    - PR body completeness check.
11. CodeZero creates a Draft or Ready PR only after self-checks pass.
12. The PR body must include language-matched summary text, self-check results, screenshot artifact references, local verification commands, and review-agent conclusions. Screenshot files must stay in CodeZero artifacts or an explicitly configured external asset host, not in the target repository PR branch.
13. GitHub PR comments and review comments are synchronized back into the same task.
14. CodeZero repeats `modify -> self-check -> update same PR -> reply to user` in the same sandbox until the user is satisfied.
15. The user merges. CodeZero does not merge by itself unless a future repository setting explicitly allows it.

## Planning Document Contract

The planning document is the external agreement with the user. It is the PRD and execution plan in one artifact. It must be visible on the GitHub issue, not only stored internally.

The planning comment should include:

- Background.
- Goals.
- Non-goals.
- User stories.
- Acceptance criteria.
- Files to read.
- Files expected to change.
- Tests to add or update.
- Commands to run.
- Risks.
- Unknowns.
- Task type.
- Complexity score and review requirement.
- Approval instructions when human review is required.

The planning document should use the issue language. Chinese issues get Chinese planning comments; English issues get English planning comments. Code identifiers and shell commands stay in their original form.

## Repository-Level Intelligence

Repository intelligence is owned by the repository, not by a single task.

CodeGraph:

- Stores a repository cache under `data/codegraph/<owner--repo>/codegraph.db`.
- Initializes once and syncs on later issue runs.
- Produces task-specific CodeGraph context before planning so the planning document is grounded in code.

Understand-Anything:

- Stores the official graph under `data/understand-anything/<owner--repo>/repo/.understand-anything/knowledge-graph.json`.
- Is generated from the repository dashboard.
- Is displayed in the repository-level knowledge graph panel.
- Is injected into issue execution context when available.

Repo Navigation Graph:

- Produces issue-specific navigation routes from repository files, symbols, history, routes, and tests.
- Is task-specific but derived from repository structure.

## Repository Rules And Skills

Each repository can configure an independent `project_skill_path`, defaulting to `.agent`.

CodeZero reads:

- `.agent/project.md` for repository rules and product context.
- `.agent/testing-guide.md` for verification expectations.
- `.agent/skills/*/SKILL.md` for repository-specific skills.

These rules and skills must be injected into context creation, planning, implementation, and review. A repository skill is not just a name; its useful content must be available to the agents within a controlled token budget.

## Human Review Policy

Human planning review is required when the model marks the planning document as complex, risky, or uncertain and the repository policy allows review gates.

Human approval can come from:

- The dashboard PRD approval action.
- A GitHub issue comment that includes the repository bot mention and an approval phrase such as `approve prd`, `批准 PRD`, or `同意执行`.

Approval resumes the same task and the same task sandbox. It must not create a duplicate task, duplicate branch, or new feedback sandbox.

## Implementation Contract

Implementation happens inside the task sandbox branch.

CodeZero owns orchestration, state, policies, self-checks, GitHub comments, and PR updates. It should not try to reimplement a full coding-agent editing loop as fragile JSON file operations.

The default implementation path is:

1. CodeZero writes a task prompt into the sandbox artifact directory.
2. CodeZero injects provider configuration derived from the user's CodeZero API key/model settings into the executor process environment.
3. CodeZero runs the internal coding executor command in the sandbox repository.
4. The executor modifies the Git worktree directly and exits.
5. CodeZero reads `git diff`, stores artifacts, syncs repo intelligence, and runs quality gates.

The current default executor command is configured in `config/sandbox.yaml` under `sandbox.implementation_executor`. It uses OpenCode internally through `OPENCODE_BIN`/`opencode`, attaches the generated CodeZero request as a prompt file, and runs non-interactively inside an isolated OpenCode home under the task artifact directory. For OpenAI-compatible gateways, CodeZero writes a temporary `OPENCODE_CONFIG` artifact that registers the configured model while keeping the API key in environment variables. Users can also override `providers.<id>.coding_executor` to select any native or custom OpenCode provider/model for sandbox implementation work, such as DeepSeek through `deepseek/<model>`. This must not leak into PR bodies or user-facing issue comments. PRs, issue comments, and dashboard summaries should describe the work as CodeZero implementation.

There is no JSON edit fallback in the implementation phase. CodeZero must fail fast and surface executor diagnostics if OpenCode cannot produce a diff, rather than applying self-built file replacement tools.

Tool Gateway still matters for read, search, shell, and future high-risk tool governance. The main implementation path, however, is CodeZero directly modifying the sandbox through OpenCode, not a model handing CodeZero snippets to paste.

Failed self-checks should feed back into the implementation loop. Executor failures should not be treated as user action required unless the same blocking condition repeats and the task cannot progress safely.

Quality gates are part of the implementation loop, not the end of the conversation. If tests, lint, typecheck, build, screenshots, or review-agent checks fail because of the agent's code, CodeZero should provide the failure output back to the implementation agent and retry up to the repository sandbox retry budget. If the failure is clearly environmental, such as Docker not being available for a configured setup gate, CodeZero should block with an explicit environment reason instead of making unrelated code changes.

Repositories that need local infrastructure should define both:

- A repository `.agent` skill explaining the local environment and verification commands.
- A `quality_gates.setup` command that prepares the sandbox before tests and screenshots.

## PR Contract

Before PR creation or PR update:

- All configured quality gates must pass.
- The review agent must approve.
- Frontend screenshots must be captured when configured.
- The PR body completeness check must pass.

The PR must include:

- Linked issue.
- Language-matched summary.
- PRD goals or PRD reference.
- Self-check results.
- Review-agent result.
- Local verification commands.
- Screenshot artifact references when screenshots exist, without committing screenshot files to the target repository branch.
- The same branch for later feedback iterations.

## Dashboard Contract

The dashboard should make repository-level and task-level state distinct:

- Repository queue and sync status.
- Repository CodeGraph / Knowledge Graph status.
- Task trace and artifacts.
- PRD review gate.
- Quality gates and screenshot artifacts.
- PR/feedback iteration state.

Long content should be paginated, collapsed, or scrollable. The dashboard should not require the user to inspect huge raw blobs to understand task progress.

## Non-Goals

- CodeZero does not merge PRs by default.
- CodeZero does not silently bypass human PRD review when configured and required.
- CodeZero does not treat repository intelligence as throwaway per-issue data.
- CodeZero does not rely on a human manually importing issues, manually retrying ordinary failures, or manually pasting screenshots.
