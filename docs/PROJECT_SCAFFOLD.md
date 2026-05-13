# 项目脚手架蓝图

## 1. 推荐目录

```text
agent-prd-automation/
  apps/
    web/
      src/
        app/
        components/
        features/tasks/
        lib/api.ts
    api/
      src/
        routes/
        services/
        server.ts
    worker/
      src/
        workflows/
        activities/
        worker.ts
  packages/
    shared/
      src/types/
    orchestrator/
      src/state-machine.ts
      src/workflow-engine.ts
      src/guards.ts
    agent-runtime/
      src/agent.ts
      src/provider.ts
      src/tools.ts
      src/structured-output.ts
      src/tracing.ts
    sandbox/
      src/docker-sandbox.ts
      src/worktree-sandbox.ts
      src/sandbox-manager.ts
    skills/
      src/platform-skill-loader.ts
      platform/
        brainstorm-requirements/
        draft-prd/
        repo-context-compress/
        minimal-change-planner/
        frontend-verification/
        backend-verification/
        pr-compliance-review/
    project-context/
      src/project-skill-loader.ts
      src/repo-scanner.ts
      src/context-compressor.ts
    codebase-intelligence/
      src/indexer/file-indexer.ts
      src/indexer/symbol-indexer.ts
      src/indexer/embedding-indexer.ts
      src/navigation-graph/repo-graph-builder.ts
      src/navigation-graph/navigation-route.ts
      src/search/agentic-search.ts
      src/search/hybrid-search.ts
      src/evidence/evidence-scorer.ts
      src/project-map/project-map-updater.ts
    memory/
      src/memory-store.ts
      src/memory-retriever.ts
      src/memory-proposal.ts
    tool-gateway/
      src/tool-registry.ts
      src/tool-permissions.ts
      src/mcp-adapter.ts
    policy-engine/
      src/policy-loader.ts
      src/policy-evaluator.ts
    observability/
      src/trace-recorder.ts
      src/run-replay.ts
      src/cost-metrics.ts
    evals/
      src/golden-issue-runner.ts
      src/assertions.ts
    repo-onboarding/
      src/onboarding-agent.ts
      src/project-map-generator.ts
    security/
      src/secret-scan.ts
      src/dependency-audit.ts
      src/prompt-injection-scan.ts
    verification/
      src/test-runner.ts
      src/playwright-screenshot.ts
      src/result-parser.ts
    github/
      src/github-app.ts
      src/issues.ts
      src/pull-requests.ts
    prompts/
      system/
      task/
  config/
    agents.example.yaml
    sandbox.example.yaml
    repositories.example.yaml
    policies.example.yaml
    tools.example.yaml
  infra/
    docker/
      sandbox.Dockerfile
      docker-compose.yml
    migrations/
  docs/
```

## 2. 配置样例

### 2.1 Agent 配置

```yaml
providers:
  default:
    type: openai-compatible
    base_url: "${OPENAI_BASE_URL}"
    api_key_env: "OPENAI_API_KEY"
    model: "${OPENAI_MODEL}"
    supports_tools: true
    supports_structured_output: true
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
  prd:
    provider: qwen_fast
    system_prompt: prompts/system/prd-agent.md
    skills:
      - brainstorm-requirements
      - draft-prd
  implementation:
    provider: qwen_fast
    provider_by_complexity:
      low: qwen_fast
      medium: qwen_fast
      high: deepseek_strong
    system_prompt: prompts/system/main-agent.md
    skills:
      - repo-context-compress
      - minimal-change-planner
  review:
    provider: deepseek_strong
    system_prompt: prompts/system/review-agent.md
    skills:
      - pr-compliance-review
```

### 2.2 仓库配置

```yaml
repositories:
  - id: example-web
    github_owner: your-org
    github_repo: your-repo
    default_branch: main
    project_skill_path: ".agent"
    trigger:
      mode: mention
      mention: "@agent-prd"
      auto_events:
        - issues.opened
        - issues.reopened
      label_allowlist:
        - agent-ready
      label_blocklist:
        - no-agent
    codebase_intelligence:
      navigation_graph:
        enabled: true
        include_git_history: true
        include_codeowners: true
        max_depth: 4
    queue:
      max_concurrent_issues: 2
    permissions:
      allowed_tools:
        - repo.search
        - repo.read_file
        - repo.apply_patch
        - shell.run
      blocked_tools: []
      allowed_permissions:
        - read
        - repo_write
        - safe_write
      blocked_permissions:
        - dangerous
    frontend:
      dev_command: "npm run dev"
      test_command: "npm test"
      screenshot_urls:
        - "http://localhost:3000/"
    backend:
      test_command: "npm test"
    pr:
      default_draft: true
    quality_gates:
      build: "npm run build"
      lint: "npm run lint"
      typecheck: "npm run typecheck"
      unit_test: "npm test"
```

### 2.3 沙箱配置

```yaml
sandbox:
  mode: docker
  image: agent-sandbox-node:latest
  network:
    allow:
      - github.com
      - api.openai.com
      - registry.npmjs.org
  filesystem:
    allow_repo_only: true
  limits:
    max_runtime_minutes: 90
    max_diff_files: 30
    max_diff_lines: 1200
    max_quality_gate_retries: 3
```

## 3. 数据库表

第一版建议表：

- `tasks`
- `task_events`
- `artifacts`
- `agent_runs`
- `sandboxes`
- `human_reviews`
- `repositories`
- `agent_configs`
- `skill_versions`
- `codebase_indexes`
- `context_packs`
- `project_map_updates`
- `memory_records`
- `memory_links`
- `memory_embeddings`
- `repo_graph_nodes`
- `repo_graph_edges`
- `navigation_routes`
- `tool_calls`
- `policy_decisions`
- `trace_spans`
- `eval_runs`
- `eval_results`
- `security_findings`

## 4. API 草案

```text
POST   /webhooks/github
POST   /tasks/import-issue
GET    /tasks
GET    /tasks/repositories
GET    /tasks/:id
GET    /tasks/:id/events
POST   /tasks/:id/approve-prd
POST   /tasks/:id/request-prd-changes
POST   /tasks/:id/pause
POST   /tasks/:id/resume
POST   /tasks/:id/cancel
POST   /tasks/:id/retry
POST   /tasks/:id/mark-dependency
GET    /tasks/:id/artifacts/:artifactId
POST   /tasks/:id/approve-memory-update
POST   /tasks/:id/reject-memory-update
GET    /tasks/:id/trace
GET    /tasks/:id/navigation-route
GET    /memories?status=proposed
POST   /memories/:id/approve
POST   /memories/:id/reject
POST   /tasks/:id/tool-approvals/:approvalId/approve
POST   /tasks/:id/tool-approvals/:approvalId/reject
POST   /repositories/:id/onboard
POST   /evals/golden-issues/run
GET    /settings/config
GET    /settings/config/:section
POST   /settings/config/:section/validate
PUT    /settings/config/:section
POST   /settings/providers/validate
PUT    /settings/repositories/:repositoryId/runtime
```

## 5. 看板页面

当前第一版页面：

- `/`：Run Console + Settings Console，包含仓库队列卡片、仓库级 queued/running/limit 计数、选中仓库的任务列表、选中 task 详情、Trace Replay timeline、质量/工具/policy 摘要、Memory Inbox approve/reject、仓库 trigger/并发/权限快捷配置，以及模型、仓库、工具权限、Policy、沙箱 YAML 编辑。
- `/tasks/:id`：任务详情。
- `/settings/agents`：后续可拆出的 Agent provider 和模型配置页面。
- `/settings/repositories`：后续可拆出的仓库配置页面。
- `/settings/skills`：后续可拆出的平台 skill 版本和项目 skill 检查页面。

## 6. MVP 实现顺序

1. 初始化 monorepo。
2. 实现数据模型和任务状态机。
3. 实现单用户看板。
4. 实现 GitHub Issue 导入。
5. 实现 PRD Agent。
6. 实现人工审核门禁。
7. 实现 Docker 沙箱 clone。
8. 实现 codebase index：路径、符号、业务 skill、历史变更。
9. 实现 Repo Navigation Graph 和 navigation route。
10. 实现 agentic search 和 ContextPack。
11. 实现上下文压缩。
12. 实现主 Agent 最小修改计划和执行。
13. 实现 Issue 独立分支和跨 Issue 污染检查。
14. 实现 build/lint/test/typecheck 质量门禁。
15. 实现前后端验证。
16. 实现 Review subagent。
17. 实现 draft PR 创建。
18. 实现 PR 本地验证指令生成。
19. 实现 trace replay 和基础 observability。
20. 实现 policy-as-code 和 security scanning。
21. 实现 golden issue eval harness。
22. 实现 MCP tool gateway 和 tool permission UI。
23. 实现 Repository Onboarding Agent。
24. 实现项目地图更新建议。
25. 实现 memory proposal 和 memory retrieval。
