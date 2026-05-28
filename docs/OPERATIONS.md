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

看板会按仓库展示运行队列、queued/running/review/blocked 计数、仓库并发上限、选中仓库的 Understand-Anything Knowledge Graph、issue 列表、选中 task 的 Trace Replay、tool/policy/quality gate 摘要、Settings Console 配置中心，以及 Memory Inbox。Memory Inbox 的 approve/reject 会调用同一组 Memory API，因此可以直接演示“proposal -> human review -> approved memory -> ContextPack”的闭环。

Task API：

```text
GET  http://localhost:4000/tasks
GET  http://localhost:4000/tasks/repositories
GET  http://localhost:4000/tasks/<task-id>/trace
POST http://localhost:4000/tasks/import-issue
POST http://localhost:4000/tasks/<task-id>/approve-prd
```

Project Knowledge Graph API：

```text
GET  http://localhost:4000/repositories/<repository-id>/knowledge-graph
POST http://localhost:4000/repositories/<repository-id>/knowledge-graph/generate
POST http://localhost:4000/repositories/<repository-id>/knowledge-graph/dashboard
```

项目知识图严格复用开源项目 [Understand-Anything](https://github.com/Lum1104/Understand-Anything) 的官方流程。首次使用前按上游方式安装 Codex skill：

```bash
curl -fsSL https://raw.githubusercontent.com/Lum1104/Understand-Anything/main/install.sh | bash -s codex
```

点击生成时，API 会将配置仓库 checkout 到被 Git 忽略的 `data/understand-anything/<owner>--<repo>/repo/`，再调用 Codex 执行官方 `$understand --language zh` 多 Agent pipeline。只有上游规定的 `.understand-anything/knowledge-graph.json` 存在时状态才会变为 `ready`。点击打开后，系统按官方 `/understand-dashboard` 规约启动上游 Vite dashboard，并通过 `GRAPH_DIR` 将该真实产物呈现在 Run Console 中。已有的 CodeGraph 与 Repo Navigation Graph 继续负责 issue 上下文检索，不作为此可视知识图的替代数据源。

可选环境变量：

```bash
UNDERSTAND_ANYTHING_LANGUAGE=zh
UNDERSTAND_ANYTHING_TIMEOUT_MS=5400000
UNDERSTAND_ANYTHING_PLUGIN_ROOT=/absolute/path/to/understand-anything-plugin
CODEX_COMMAND=codex
```

Settings API：

```text
GET  http://localhost:4000/settings/config
GET  http://localhost:4000/settings/config/<agents|repositories|tools|policies|sandbox>
POST http://localhost:4000/settings/config/<section>/validate
PUT  http://localhost:4000/settings/config/<section>
POST http://localhost:4000/settings/providers/validate
PUT  http://localhost:4000/settings/repositories/<repository-id>/runtime
```

Settings Console 会保存到实际 `config/*.yaml`，保存前使用同一套 Zod schema 校验。当前可在 WebUI 完成：

- 大模型 provider 配置：DeepSeek、Qwen、OpenAI-compatible gateway。
- 大模型连通性验证：选择 provider 后点击 Test，会真实请求 `/chat/completions` 验证 base URL、model 和 API key 是否可用。
- Agent step routing：`prd`、`implementation`、`review` 等步骤选择 provider。
- Complexity routing：`provider_by_complexity.low|medium|high`，让简单任务走快速/便宜模型，复杂任务走强模型。
- Sandbox coding executor routing：`providers.<id>.coding_executor` 可覆盖实现阶段沙箱内 coding executor 使用的 provider/model。默认 `auto` 会复用当前 OpenAI-compatible provider；`native` 可直接使用 OpenCode 支持的 provider/model；`custom` 可注册任意 OpenAI-compatible 或第三方网关。
- GitHub 仓库配置：owner、repo、default branch、trigger mode、quality gates、frontend screenshot URLs。
- 仓库级运行上限：`queue.max_concurrent_issues` 控制每个仓库最多同时执行几个 issue。
- 仓库级权限：每个 repository 可配置 tool allowlist/blocklist 和 permission allowlist/blocklist，执行时会合成 Tool Gateway policy。
- 仓库快捷配置：Repository Quick Settings 可直接修改 trigger mode、mention、并发上限、allowed permissions 和 blocked permissions。
- Tool Gateway 权限：tool permission、timeout、policy refs。
- Policy-as-code：路径、命令、权限、工具名匹配，以及 `block` / `require_approval` 动作。
- Sandbox：docker/worktree、image、network allowlist、runtime limits。

Secret 不直接明文保存在 WebUI 中；provider 仍通过 `api_key_env` 引用 `.env` 或部署环境变量。Provider Connection Test 支持输入一次性 API key 做验证，但该 key 只用于本次请求，不写入 YAML。

Complexity routing 示例：

```yaml
providers:
  qwen_fast:
    type: openai-compatible
    base_url: "${QWEN_BASE_URL}"
    api_key_env: "QWEN_API_KEY"
    model: "qwen3.5"
  deepseek_strong:
    type: openai-compatible
    base_url: "${DEEPSEEK_BASE_URL}"
    api_key_env: "DEEPSEEK_API_KEY"
    model: "deepseek-v4"

agents:
  implementation:
    provider: qwen_fast
    provider_by_complexity:
      low: qwen_fast
      medium: qwen_fast
      high: deepseek_strong
    system_prompt: prompts/system/main-agent.md
    skills:
      - repo-context-compress
      - implementation-scope-planner
```

Coding executor provider 示例：

```yaml
providers:
  default:
    type: openai-compatible
    base_url: "${OPENAI_BASE_URL}"
    api_key_env: "OPENAI_API_KEY"
    model: "${OPENAI_MODEL}"

    # 只影响 sandbox 内实现代码的 executor；PRD/review 等 CodeZero 编排模型仍走上面的 provider。
    coding_executor:
      mode: native
      provider_id: anthropic
      model: claude-sonnet-4-5
      env:
        ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}"

  openrouter_impl:
    type: openai-compatible
    base_url: "${OPENROUTER_BASE_URL}"
    api_key_env: "OPENROUTER_API_KEY"
    model: "planner-model"
    coding_executor:
      mode: custom
      provider_id: openrouter
      model: anthropic/claude-sonnet-4-5
      options:
        baseURL: "https://openrouter.ai/api/v1"
        apiKey: "{env:OPENROUTER_API_KEY}"
```

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
    queue:
      max_concurrent_issues: 2
    permissions:
      allowed_tools:
        - repo.search
        - repo.read_file
        - shell.run
      blocked_tools: []
      allowed_permissions:
        - read
        - repo_write
        - safe_write
      blocked_permissions:
        - dangerous
```

推荐使用方式：

- 内部低风险工具仓库：`auto`。
- 开源或多人协作仓库：`mention`。
- 已有 triage 流程的团队仓库：`label`。
- 高风险或灰度仓库：`manual` 或 `disabled`。

### 5.2 仓库级并发队列

`repositories.yaml` 的 `queue.max_concurrent_issues` 是每个仓库的硬上限。worker 启动多个并发槽位时，会先检查同仓库正在消耗算力的任务数；达到上限后，后续任务保持 `QUEUED`，并按 `REPOSITORY_QUEUE_RETRY_MS` 延迟重试。

```bash
WORKER_CONCURRENCY=4 REPOSITORY_QUEUE_RETRY_MS=15000 pnpm dev:worker
```

Run Console 的 repository cards 会显示每个仓库的 queued 数、running/max、review 和 blocked 数，点击仓库即可查看该仓库的 issue 队列。

## 6. 执行门禁

worker 会按顺序执行：

1. 创建或恢复同一个 task sandbox。
2. Issue 独立分支。
3. codebase index。
4. agentic search。
5. ContextPack。
6. Planning Agent 生成同一份 PRD/Plan 文档。
7. PRD/Plan 人审门禁。
8. sandbox coding executor 通过 OpenCode 直接修改同一隔离 worktree；失败时不回退到 JSON action 或自研文件编辑工具。
9. build/lint/typecheck/unit test。
10. 前端 Chrome 截图，如果配置了 URL。
11. Review subagent。
12. commit/push/draft PR。
13. PR 人工评论触发同一分支、同一 sandbox 迭代，重新执行实现、自检、review、push 和 PR 正文刷新。

没有 OpenAI 或 GitHub 凭证时，任务会进入 `FAILED` 或 `BLOCKED` 并记录明确事件；不会假装成功。

### 6.1 目标治理配置

当前会读取：

- `config/policies.yaml`：危险路径、危险命令、高风险领域和审批策略。
- `config/tools.yaml`：工具 schema、权限等级、timeout 和 policy refs。
- `config/repositories.yaml`：仓库级触发策略、并发队列上限、工具权限、质量门禁、截图 URL 和 PR draft 策略。
- `repositories.yaml` 中的 `codebase_intelligence.codegraph`：是否在每个 issue 处理前运行 CodeGraph 建立本地代码图。
- `repositories.yaml` 中的 `codebase_intelligence.navigation_graph`：是否在 CodeGraph 外继续生成平台内置的轻量 Repo Navigation Graph / navigation route。

Tool Gateway 会按这些配置记录 tool call、policy decision 和 navigation route；后续 trace replay 会复用同一批事件。

### 6.2 CodeGraph 前置建图

每个仓库默认会在 clone 和 issue branch 创建后运行：

```bash
CODEGRAPH_FORCE_WATCH=1 npx -y @colbymchenry/codegraph@0.9.3 init /path/to/repository --index
```

这是开源项目 `colbymchenry/codegraph` 发布版的实际 CLI。建图阶段不调用大模型，而是以 Tree-sitter 解析代码关系，将 SQLite / FTS5 索引写入任务沙箱的 `.codegraph/codegraph.db`。首次成功初始化后，workflow 会把干净基线的数据库持久化到平台侧 `data/codegraph/<owner>--<repo>/codegraph.db`；后续同仓库 Issue 创建新沙箱时先复制该缓存，再执行上游 `codegraph sync ... --quiet`。由于上游在 Git 仓库中默认只看工作树变更，workflow 对恢复出的基线缓存禁用该快速路径，让上游使用内容哈希扫描以发现已经合入基线的新提交。Agent 修改任务沙箱后还会执行一次普通 `sync ... --quiet` 更新本地任务图，但不会把未合并分支写回共享缓存。上游 `init` 可能为已配置的代理写入项目 surface，所以 workflow 以一次性临时目录作为当前目录执行命令，并设置 `CODEGRAPH_FORCE_WATCH=1` 避免 fallback git hook 写入；`.codegraph/` 与 `data/codegraph/` 均被 Git 忽略，索引数据库不会进入 Agent PR diff 或被推送到目标仓库。部署时应将平台 `data/` 目录放在持久卷上，才能跨进程重启复用索引缓存。

可在 `config/repositories.yaml` 为单仓库调整：

```yaml
codebase_intelligence:
  codegraph:
    enabled: true
    package: "@colbymchenry/codegraph@0.9.3"
    init_args:
      - "--index"
    timeout_ms: 600000
    fail_on_error: true
```

`fail_on_error: true` 表示 CodeGraph 建图失败时阻断本次 issue workflow，避免 agent 在缺少代码图的情况下继续盲改。需要渐进迁移时可以临时设为 `false`，系统会记录失败事件并降级到内置轻量索引。

建图成功后，workflow 会先调用上游 `codegraph context ... --format json` 生成任务子图和关联代码，将结果写入 `codegraph-context.json` artifact 并注入 ContextPack，供 planning 与 sandbox coding executor 使用。只读 Tool Gateway 工具 `codegraph.query` 和 `codegraph.context` 可用于后续定向检索；它们分别委托给上游 CLI 的 `codegraph query ... --json` 与 `codegraph context ... --format json` 命令。

## 7. PR 本地验证模板

Agent 创建 PR 前会生成 `pr-local-verification.json` artifact，并把同一份验证计划渲染进 PR 描述。PR 默认跟随 Issue/评论语言：中文 Issue 生成中文 PRD、计划、review notes 和 PR 正文；英文 Issue 生成英文输出。开发者可以直接复制运行：

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
- Screenshots: `![viewport](https://raw.githubusercontent.com/.../.agent/screenshots/...)`
````

当前实现会从 lockfile 推导安装命令，从 `repositories.yaml` 的 `quality_gates` 和 `frontend.dev_command` 推导验证/启动命令，并写入质量门禁结果和截图 artifact。前端截图会复制进 PR 分支的 `.agent/screenshots/issue-<number>/`，PR 正文使用 GitHub raw URL 直接嵌图，避免只给本地路径或不可渲染链接。后续 Review subagent 会阻断缺少本地验证说明的 PR。

PR 创建后，GitHub PR conversation 中的人工评论会被 webhook 映射回已有 task。系统不会新建另一个 Issue task，也不会新开 feedback sandbox；它会恢复同一个 task sandbox 和同一个 PR 分支，应用用户反馈、重新跑质量门禁和 review subagent，通过后 push 并更新原 PR 正文，再在 PR 里回复本轮已处理。用户继续评论时重复这一轮，直到用户满意并自行合并。
