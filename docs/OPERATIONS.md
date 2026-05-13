# 本地运行与真实接入

## 1. 必需配置

复制配置文件：

```bash
cp config/agents.example.yaml config/agents.yaml
cp config/repositories.example.yaml config/repositories.yaml
cp config/sandbox.example.yaml config/sandbox.yaml
cp config/policies.example.yaml config/policies.yaml
cp config/tools.example.yaml config/tools.yaml
cp .env.example .env
```

设置环境变量：

```bash
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=...
OPENAI_MODEL=...
GITHUB_TOKEN=...
GITHUB_WEBHOOK_SECRET=...
AGENT_TRIGGER_MENTION=@agent-prd
MEMORY_STORE_FILE=./data/memory.json
REDIS_URL=redis://localhost:6379
```

国产 API 示例：

```bash
# DeepSeek
OPENAI_BASE_URL=https://api.deepseek.com
OPENAI_API_KEY=...
OPENAI_MODEL=deepseek-v4

# Qwen / OpenAI-compatible gateway
OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
OPENAI_API_KEY=...
OPENAI_MODEL=qwen3.5
```

项目内部仍统一称为 `OPENAI_*`，含义是 OpenAI-compatible provider，并不限定使用 OpenAI 官方 API。

`GITHUB_TOKEN` 需要权限：

- 读取 Issue。
- push 分支。
- 创建 draft PR。

## 2. 启动依赖

```bash
docker compose -f infra/docker/docker-compose.yml up -d
```

API 的只读接口、Trace Replay 和 Memory Inbox 可以在 Redis 未启动时运行；手动导入 Issue、PRD 审批后继续 workflow、worker 消费任务需要 Redis。

默认使用文件存储 `data/tasks.json`。如需 Postgres：

```bash
STORAGE_DRIVER=postgres
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/agent_prd
```

Memory proposal 和 approved memory 默认存储在 `data/memory.json`，可通过 `MEMORY_STORE_FILE` 覆盖。

## 3. 启动服务

```bash
pnpm dev:api
pnpm dev:worker
pnpm dev:web
```

看板：

```text
http://localhost:3000
```

API：

```text
http://localhost:4000
```

Trace Replay API：

```text
GET http://localhost:4000/tasks/<task-id>/trace
```

该接口会把 task events 和 artifacts 组织成 timeline spans，用于定位模型、工具、policy、导航图、质量门禁或 Review 阶段的问题。

Memory 审核 API：

```text
GET  http://localhost:4000/memories?status=proposed
POST http://localhost:4000/memories/<memory-id>/approve
POST http://localhost:4000/memories/<memory-id>/reject
```

只有 `approved` memory 会在后续 ContextPack 构建时被检索。

Run Console：

```text
http://localhost:3000
```

看板会展示 task 列表、选中 task 的 Trace Replay、tool/policy/quality gate 摘要，以及 Memory Inbox。Memory Inbox 的 approve/reject 会调用同一组 Memory API，因此可以直接演示“proposal -> human review -> approved memory -> ContextPack”的闭环。

Golden Issue Eval：

```bash
pnpm eval:golden
```

该命令会读取 `evals/golden-issues` 与 `evals/candidates`，生成：

```text
artifacts/eval-report.json
artifacts/eval-report.md
```

CI 中同样会运行 `pnpm check` 和 `pnpm eval:golden`，并上传 eval report artifact。

Repository Onboarding：

```bash
pnpm onboard:repo -- --repo-dir /path/to/repo --owner your-org --repo your-repo --trigger-mode mention --mention @agent
```

该命令会扫描目标仓库并生成可审查的 `.agent/project.md`、`.agent/module-map.md`、`.agent/route-map.md`、`.agent/testing-guide.md`，以及 `config/repositories.suggested.yaml` 和 `config/policies.suggested.yaml`。

## 4. 手动导入 Issue

```bash
curl -X POST http://localhost:4000/tasks/import-issue \
  -H 'content-type: application/json' \
  -d '{
    "owner": "your-org",
    "repo": "your-repo",
    "number": 123,
    "url": "https://github.com/your-org/your-repo/issues/123",
    "title": "Example issue",
    "body": "Issue body",
    "labels": ["frontend"],
    "baseBranch": "main"
  }'
```

## 5. GitHub Webhook

Webhook URL：

```text
POST /webhooks/github
```

支持事件：

- `issues.opened`
- `issues.labeled`
- `issues.reopened`
- `issue_comment.created`

当前实现按 `repositories.yaml` 的仓库级 `trigger.mode` 判断是否入队：

- `auto`：匹配 `trigger.auto_events` 的 Issue 事件会创建任务。
- `mention`：只有 `issue_comment.created` 且评论包含仓库配置的 `trigger.mention` 才创建任务。
- `label`：Issue 标签命中 `trigger.label_allowlist` 时创建任务。
- `manual`：Webhook 不自动创建任务，只能手动导入。
- `disabled`：Webhook 忽略该仓库。

如果仓库没有配置，webhook 会忽略该事件，避免 Bot 接管未知仓库。

GitHub Webhook 配置时，`Events` 至少选择：

- Issues
- Issue comments

如果设置了 `GITHUB_WEBHOOK_SECRET`，服务会使用 `x-hub-signature-256` 做真实验签。

### 5.1 仓库级触发策略

为了让同一个 GitHub Bot 服务多个仓库，触发策略配置在 `repositories.yaml`：

```yaml
repositories:
  - id: example-web
    github_owner: your-org
    github_repo: your-repo
    trigger:
      mode: mention # auto | mention | label | manual | disabled
      mention: "@agent-prd"
      auto_events:
        - issues.opened
        - issues.reopened
      label_allowlist:
        - agent-ready
      label_blocklist:
        - no-agent
        - security-review
```

推荐使用方式：

- 内部低风险工具仓库：`auto`。
- 开源或多人协作仓库：`mention`。
- 已有 triage 流程的团队仓库：`label`。
- 高风险或灰度仓库：`manual` 或 `disabled`。

## 6. 执行门禁

worker 会按顺序执行：

1. PRD Agent。
2. PRD 人审门禁。
3. Docker 沙箱 clone。
4. Issue 独立分支。
5. codebase index。
6. agentic search。
7. ContextPack。
8. minimal change plan。
9. implementation JSON action / patch，经 Tool Gateway 执行。
10. build/lint/typecheck/unit test。
11. 前端 Chrome 截图，如果配置了 URL。
12. Review subagent。
13. commit/push/draft PR。

没有 OpenAI 或 GitHub 凭证时，任务会进入 `FAILED` 或 `BLOCKED` 并记录明确事件；不会假装成功。

### 6.1 目标治理配置

当前会读取：

- `config/policies.yaml`：危险路径、危险命令、高风险领域和审批策略。
- `config/tools.yaml`：工具 schema、权限等级、timeout 和 policy refs。
- `repositories.yaml` 中的 `codebase_intelligence.navigation_graph`：是否构建 Repo Navigation Graph。

Tool Gateway 会按这些配置记录 tool call、policy decision 和 navigation route；后续 trace replay 会复用同一批事件。

## 7. PR 本地验证模板

Agent 创建 PR 前会生成 `pr-local-verification.json` artifact，并把同一份验证计划渲染进 PR 描述。开发者可以直接复制运行：

````markdown
## Local Verification

### Option A: GitHub CLI

```bash
gh repo clone <owner>/<repo>
cd <repo>
gh pr checkout <agent-branch>
<install-command>
<quality-gate-command>
<dev-command-if-needed>
```

### Option B: Plain Git

```bash
git clone https://github.com/<owner>/<repo>.git
cd <repo>
git fetch origin <agent-branch>
git checkout <agent-branch>
<install-command>
<quality-gate-command>
<dev-command-if-needed>
```

### Agent Verification

- Base branch: `<base-branch>`
- Base commit: `<base-sha>`
- Agent branch: `<agent-branch>`
- Sandbox mode: `<docker|worktree>`
- Sandbox image: `<sandbox-image>`
- Quality gates: `<build/lint/typecheck/test summary>`
- Screenshots: `<artifact links>`
````

当前实现会从 lockfile 推导安装命令，从 `repositories.yaml` 的 `quality_gates` 和 `frontend.dev_command` 推导验证/启动命令，并写入质量门禁结果和截图 artifact。后续 Review subagent 会阻断缺少本地验证说明的 PR。
