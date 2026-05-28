# CodeZero Core Product Flow

This document is the canonical product contract for CodeZero. Keep it current before changing workflow behavior. It is intentionally explicit so future agents can recover the product logic after context compaction.

## Product Intent

CodeZero is a GitHub Issue/PR automation product. A user should be able to mention the bot in an issue, review the bot's PRD, let the bot implement in an isolated sandbox, and then review a pull request that already contains self-check results and visible screenshots. The user decides when to merge unless auto-merge is explicitly configured later.

## Main Loop

1. A GitHub issue or issue comment triggers the configured repository mention, for example `@codeZero`.
2. CodeZero asynchronously imports the issue and creates one task for that repository/issue pair.
3. The PRD agent generates a user-facing PRD from the issue, repository rules, repository skills, and available repository intelligence.
4. CodeZero comments the PRD back to the GitHub issue.
5. If the PRD is low-risk, CodeZero auto-approves it and continues. If it is complex, risky, or uncertain, CodeZero waits for human PRD approval from the dashboard or an issue comment such as `@codeZero approve prd`.
6. After PRD approval, CodeZero prepares an isolated sandbox branch for the issue.
7. CodeZero loads repository-level intelligence and updates issue-specific context:
   - CodeGraph database and task context.
   - Repo Navigation Graph and route.
   - Understand-Anything knowledge graph, when generated for the repository.
   - Repository project rules, testing guide, and `.agent/skills/*/SKILL.md`.
   - Approved memories from previous tasks.
8. CodeZero creates an internal Execution Plan. This is not a second PRD; it is the implementation checklist for files, tests, commands, and risk notes.
9. CodeZero invokes its internal coding executor in the sandbox. The default executor is a CLI coding agent configured from the user's CodeZero model/API settings, so it can read files, edit code, run local commands, and repair failures directly in the isolated worktree. The user-facing product remains CodeZero; the executor implementation is an internal runtime detail.
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
12. The PR body must include language-matched summary text, self-check results, direct visible screenshots, local verification commands, and review-agent conclusions.
13. GitHub PR comments and review comments are synchronized back into the same task.
14. CodeZero repeats `modify -> self-check -> update same PR -> reply to user` until the user is satisfied.
15. The user merges. CodeZero does not merge by itself unless a future repository setting explicitly allows it.

## PRD Contract

The PRD is the external agreement with the user. It must be visible on the GitHub issue, not only stored as an internal artifact.

The PRD comment should include:

- Background.
- Goals.
- Non-goals.
- User stories.
- Acceptance criteria.
- Risks.
- Unknowns.
- Task type.
- Complexity score and review requirement.
- Approval instructions when human review is required.

The PRD should use the issue language. Chinese issues get Chinese PRDs and PR comments; English issues get English PRDs and PR comments. Code identifiers and shell commands stay in their original form.

## Repository-Level Intelligence

Repository intelligence is owned by the repository, not by a single task.

CodeGraph:

- Stores a repository cache under `data/codegraph/<owner--repo>/codegraph.db`.
- Initializes once and syncs on later issue runs.
- Produces task-specific CodeGraph context after PRD approval.

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

These rules and skills must be injected into PRD generation, context creation, implementation, and review. A repository skill is not just a name; its useful content must be available to the agents within a controlled token budget.

## Human Review Policy

Human PRD review is required when the model marks the PRD as complex, risky, or uncertain and the repository policy allows review gates.

Human approval can come from:

- The dashboard PRD approval action.
- A GitHub issue comment that includes the repository bot mention and an approval phrase such as `approve prd`, `批准 PRD`, or `同意执行`.

Approval resumes the same task. It must not create a duplicate task.

## Implementation Contract

Implementation happens inside the task sandbox branch.

CodeZero owns orchestration, state, policies, self-checks, GitHub comments, and PR updates. It should not try to reimplement a full coding-agent editing loop as fragile JSON file operations.

The default implementation path is:

1. CodeZero writes a task prompt into the sandbox artifact directory.
2. CodeZero injects provider configuration derived from the user's CodeZero API key/model settings into the executor process environment.
3. CodeZero runs the internal coding executor command in the sandbox repository.
4. The executor modifies the Git worktree directly and exits.
5. CodeZero reads `git diff`, stores artifacts, syncs repo intelligence, and runs quality gates.

The current default executor command is configured in `config/sandbox.yaml` under `sandbox.implementation_executor`. It uses OpenCode internally through `npx -y opencode-ai@latest`, attaches the generated CodeZero request as a prompt file, and runs non-interactively inside the isolated sandbox. For OpenAI-compatible gateways, CodeZero also writes a temporary `OPENCODE_CONFIG` artifact that registers the configured model as `codezero/<model>` while keeping the API key in environment variables. This must not leak into PR bodies or user-facing issue comments. PRs, issue comments, and dashboard summaries should describe the work as CodeZero implementation.

Legacy JSON actions remain only as a compatibility fallback:

- `repo.replace_text` for precise edits.
- `repo.write_file` for new files or complete-file replacement.
- `repo.apply_patch` only as an older compatibility fallback.

Tool Gateway still matters for the fallback path and for future high-risk tools. It provides path isolation, policy checks, event logging, and reproducibility. The main implementation path, however, should feel like CodeZero directly modifying the sandbox through a mature coding executor, not like a model handing CodeZero brittle snippets to paste.

Failed self-checks should feed back into the implementation loop. A failed patch or edit should not be treated as user action required unless the same blocking condition repeats and the task cannot progress safely.

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
- Directly embedded screenshots when screenshots exist.
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
