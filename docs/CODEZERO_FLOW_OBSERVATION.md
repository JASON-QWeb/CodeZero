# CodeZero Flow Observation

## 2026-05-28 BeautySkillsHub Issue Flow

Goal: run a full BeautySkillsHub GitHub issue through CodeZero using DeepSeek flash.

### API key handling

- Project code loads secrets from process environment and the project root `.env`.
- `.env` is ignored by Git and is the local source for `OPENAI_*`, `DEEPSEEK_*`, `GITHUB_TOKEN`, and `OPENCODE_BIN`.
- The code does not read `/Users/justq/Desktop/api.md`; that file was only used manually to copy the DeepSeek key into local `.env`.
- OpenCode config artifacts use `{env:DEEPSEEK_API_KEY}` and do not store the raw key.

### Issues observed

- `#3` failed during PRD parsing because DeepSeek flash returned a planning JSON variant where `implementationPlan.goal` was missing and `implementationPlan.riskNotes` was a string.
- `#3` and `#4` then exposed an OpenCode runtime problem: CodeZero wrapped DeepSeek as `codezero/deepseek-v4-flash` instead of using OpenCode's native `deepseek/*` provider.
- Running through `npx opencode-ai@latest` made npm's parent process expose environment variables in the local process command line.
- OpenCode reused a global project marker in `.git/opencode`; the global OpenCode DB mapped the BeautySkillsHub project id to an older sandbox, causing later task sandboxes to stall before useful JSON events.
- `#5` confirmed another OpenCode hang cause: CodeZero opened a child-process stdin pipe but never closed it when no stdin was provided, so `opencode run` could finish bootstrapping and then wait forever before creating a session.
- `#6` confirmed task-store corruption under streaming OpenCode output: concurrent progress-event writes shared the same `data/tasks.json.tmp` path, producing a valid JSON object followed by duplicated trailing bytes.
- `#7` exposed a review-stage fast-model issue: a review response occasionally returned malformed JSON and failed the workflow after implementation and quality gates had already passed.
- The local runtime had `REDIS_URL=redis://localhost:6379`, while the active local Redis for this run was exposed on `localhost:6380`; API and worker were restarted with the corrected `.env` value.
- PR `#8` exposed a PR artifact hygiene issue: screenshot PNG files were copied into `.agent/screenshots/issue-7/` on the target repository branch so GitHub raw URLs could be embedded in the PR body. This made screenshot artifacts part of the code diff.

### Fixes applied

- Planning schemas now normalize common fast-model JSON variants:
  - string fields that should be arrays are accepted and converted to one-item arrays;
  - missing `implementationPlan.goal` is derived from goals, acceptance criteria, or title.
- `config/agents.yaml` now routes the coding executor through OpenCode's native DeepSeek provider:
  - `provider_id: deepseek`
  - `model: ${DEEPSEEK_MODEL}`
  - `apiKey: {env:DEEPSEEK_API_KEY}`
- The default sandbox executor uses `OPENCODE_BIN`/`opencode` directly instead of `npx`.
- Each coding executor run now uses an isolated OpenCode `HOME`, `XDG_DATA_HOME`, and `XDG_CONFIG_HOME` under the task artifact directory.
- The stale `.git/opencode` marker is removed before launching the coding executor.
- Sandbox command execution now closes child stdin when no stdin payload is supplied.
- File-backed task persistence now serializes mutations per store file and writes through unique temporary paths before rename.
- JSON agents now retry once with a strict JSON-repair prompt when the first response cannot be parsed.
- PR screenshot handling now keeps screenshots as CodeZero task artifacts and references artifact ids in PR/issue text unless an external public image URL is explicitly provided. Screenshot files are no longer copied into the target repository PR branch.

### Completed run

- `#7` is the successful end-to-end run after the fixes above.
- It completed issue import, sandbox clone, CodeGraph context, PRD generation, GitHub PRD comment, PRD approval import, OpenCode implementation, automated repair, quality gates, review, local PR handoff, memory proposal, branch push, and draft PR creation.
- OpenCode used `deepseek/deepseek-v4-flash` through the native `deepseek/*` provider.
- Quality gates passed: setup, build, typecheck, unit test, and frontend screenshot.
- Review approved with no blocking findings and no scope violations.
- Initial draft PR `#8` was closed because it included committed screenshot artifacts.
- Replacement PR created without screenshot files: `https://github.com/JASON-QWeb/BeautySkillsHub/pull/9`.
- GitHub Actions passed on `#9`: Backend Test, Frontend Verify, and Docker Compose Smoke.
- PR `#9` was squash-merged into `main` at merge commit `bb6181f444e0cd69c777f87a24dbe0aab898b5aa`.
