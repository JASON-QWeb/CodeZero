# CodeZero Session Review And Current Business Route

Date: 2026-05-28

This document preserves the product decisions from the recent long session so future agents do not lose the core logic after context compaction.

## 1. User Goal

CodeZero should be a GitHub Issue and PR automation service. The user should be able to mention the bot on an issue, watch the dashboard, review the generated PR, comment on the PR, and merge when satisfied. The product should not depend on the operator manually importing patches, retrying implementation steps, or pasting screenshots into PRs.

The target product priorities from the session are:

1. Default user-facing language should be Chinese, with Chinese/English switching based on the user's issue or PR comment language.
2. Dashboard, issue comments, and PR bodies should expose CodeZero behavior, not internal executor details.
3. Code graph and knowledge graph must be visible at repository level and reused across issues.
4. Long dashboard/PR content must support scrolling, pagination, or compact presentation instead of forcing one oversized screenshot.
5. PR screenshots must be directly visible in the PR body, not only stored as links.
6. The robot must self-check before opening or updating PRs: frontend screenshot verification, review agent, unit tests, typecheck, lint, build, and PR content completeness.
7. The robot may request human PRD approval when complexity, risk, or policy requires it. Merge remains a user decision unless a future explicit auto-merge policy is configured.

## 2. Main Error Points And Fixes

### 2.1 Hand-rolled JSON tool execution was treated as the main coding path

Observed problem: the previous design expected the model to output JSON actions or patches, then CodeZero would apply them through Tool Gateway. This made real coding tasks brittle. Failures such as context mismatch, patch application failure, repeated repair turns, and "unable to apply to file" were symptoms of trying to rebuild a coding CLI inside the product.

Fix: CodeZero is now defined as a service orchestrator. Implementation runs through an internal sandbox coding executor that can read files, edit code, run commands, and repair failures inside the isolated worktree. Tool Gateway and JSON actions remain only for compatibility fallback, high-risk controlled tools, governance, and traceability.

### 2.2 OpenCode availability was assumed

Observed problem: the executor failed when `opencode` was not installed globally.

Fix: the default sandbox executor command uses `npx -y opencode-ai@latest`, so the runtime can bootstrap the CLI without a global install.

### 2.3 Long prompts were passed through shell arguments

Observed problem: large prompts could hit shell argument limits or become hard to quote safely.

Fix: CodeZero writes the implementation request to a prompt file and invokes the executor with `--file "$CODEZERO_PROMPT_FILE"`.

### 2.4 Xiaomi/OpenAI-compatible provider did not map cleanly to OpenCode's model registry

Observed problem: an OpenAI-compatible model such as `openai/mimo-v2.5-pro` was not recognized by OpenCode's built-in model registry.

Fix: CodeZero generates a temporary `OPENCODE_CONFIG` artifact for compatible providers. It registers an internal `codezero/<model>` provider while keeping the real API key in environment variables. The config is outside the target repository diff.

### 2.5 Dashboard provider tests depended on manually sourced env vars

Observed problem: the API could fail provider validation unless `.env` had already been sourced by the shell.

Fix: the runtime loads the project root `.env` before validating providers, without overriding existing process environment values.

### 2.6 Provider selection was too narrow

Observed problem: the implementation provider looked tied to one OpenAI-compatible route, while the user needs selectable providers.

Fix: `providers.<id>.coding_executor` supports executor-specific routing:

- `auto`: reuse the configured OpenAI-compatible provider through CodeZero's temporary executor config.
- `custom`: register a custom executor provider/model and options.
- `native`: use an executor-native provider/model directly.

### 2.7 PRD and implementation planning were blurred

Observed problem: there was confusion about why a plan exists after PRD approval.

Fix: PRD is the product/acceptance contract and is commented back to the GitHub issue. Human review is required only when policy/risk/complexity says so. After approval or auto-approval, the minimal change plan is an implementation artifact that maps the accepted PRD to files, tests, commands, and risk notes. It is not a second PRD.

### 2.8 Old docs still described the obsolete route

Observed problem: historical planning docs and several current docs still presented Tool Gateway JSON action execution as the primary coding path.

Fix: the docs now describe coding executor as the main implementation route and Tool Gateway as fallback/governance. The old `docs/archive` planning notes were removed from the active tree to reduce future confusion.

## 3. Current Business Route

The current intended end-to-end flow is:

1. User creates or comments on a GitHub issue and mentions the CodeZero bot.
2. GitHub webhook ingests the event.
3. Repository trigger policy decides whether CodeZero should run.
4. The task enters the repository queue with per-repository concurrency limits.
5. CodeZero generates a PRD and comments it on the issue in the user's language.
6. If the task is risky or complex, PRD review is required; otherwise CodeZero can continue automatically.
7. CodeZero prepares an isolated sandbox clone and issue branch.
8. Repository-level CodeGraph, Understand-Anything graph, Repo Navigation Graph, skills, and rules are loaded or refreshed.
9. CodeZero builds a ContextPack and minimal change plan.
10. CodeZero starts the internal sandbox coding executor.
11. The executor modifies the sandbox worktree and can run local commands as part of implementation.
12. CodeZero reads the git diff and runs quality gates: unit tests, typecheck, lint, build, review agent, screenshot verification, and PR completeness checks.
13. Only after self-checks pass, CodeZero creates or updates a Draft/Ready PR according to policy.
14. PR body includes localized explanation, self-check results, and directly visible screenshots.
15. User comments on the PR.
16. CodeZero reads the PR comments, updates the same branch/PR, repeats implementation and self-checks, then replies to the user.
17. The loop continues until the user is satisfied.
18. Merge is controlled by the user unless a future explicit auto-merge setting is added.

## 4. Current Technical Route

CodeZero's product boundary is orchestration:

- GitHub ingestion, queueing, PRD, approval gates, dashboard state, graph/context preparation, sandbox lifecycle, verification, review, PR creation, and PR comment iteration.
- Coding implementation is delegated to an internal executor command inside the sandbox.
- OpenCode is the default executor implementation today, but it is hidden behind CodeZero. Users should configure providers in CodeZero and see CodeZero in all issue, PR, and dashboard surfaces.
- Tool Gateway remains useful for policy-managed tools, trace replay, old JSON action compatibility, and future explicit tool calls, but it is not the normal way to implement arbitrary code changes.

## 5. BeautySkillsHub Test Strategy

Downstream validation should happen in `BeautySkillsHub`, one issue at a time:

1. Make the target repository private if required by the test.
2. Trigger `@codeZero` on a single BeautySkillsHub issue.
3. Observe whether CodeZero comments the PRD, applies approval rules, creates the sandbox, runs the executor, self-checks, and opens/updates the PR.
4. If a CodeZero platform problem is found, stop the downstream test, fix CodeZero, push CodeZero `main`, then re-trigger the BeautySkillsHub issue.
5. Continue through the planned BeautySkillsHub issues only after the previous issue proves the platform loop works.

The BeautySkillsHub issues reserved for downstream testing are:

1. Make GitHub sync asynchronous instead of blocking the page.
2. Make the page-edge chat character draggable.
3. Let skills be pulled directly from GitHub URLs and auto-synced.
4. Change the main page to infinite scrolling card loading.
5. Add demo data with hundreds of records showing syncing, AI review, uploaded, and other feature states.

## 6. Current Verification Baseline

The latest completed CodeZero baseline before this cleanup included:

- `pnpm test`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm build`
- Xiaomi/OpenAI-compatible dashboard provider validation
- OpenCode executor plan validation through CodeZero provider mapping

Any future platform change should preserve this baseline before continuing downstream BeautySkillsHub testing.
