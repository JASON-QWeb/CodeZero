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
      src/search/agentic-search.ts
      src/search/hybrid-search.ts
      src/evidence/evidence-scorer.ts
      src/project-map/project-map-updater.ts
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

agents:
  prd:
    provider: default
    system_prompt: prompts/system/prd-agent.md
    skills:
      - brainstorm-requirements
      - draft-prd
  implementation:
    provider: default
    system_prompt: prompts/system/main-agent.md
    skills:
      - repo-context-compress
      - minimal-change-planner
  review:
    provider: default
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

## 4. API 草案

```text
POST   /webhooks/github
POST   /tasks/import-issue
GET    /tasks
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
```

## 5. 看板页面

第一版页面：

- `/`：任务列表。
- `/tasks/:id`：任务详情。
- `/settings/agents`：Agent provider 和模型配置。
- `/settings/repositories`：仓库配置。
- `/settings/skills`：平台 skill 版本和项目 skill 检查。

## 6. MVP 实现顺序

1. 初始化 monorepo。
2. 实现数据模型和任务状态机。
3. 实现单用户看板。
4. 实现 GitHub Issue 导入。
5. 实现 PRD Agent。
6. 实现人工审核门禁。
7. 实现 Docker 沙箱 clone。
8. 实现 codebase index：路径、符号、业务 skill、历史变更。
9. 实现 agentic search 和 ContextPack。
10. 实现上下文压缩。
11. 实现主 Agent 最小修改计划和执行。
12. 实现 Issue 独立分支和跨 Issue 污染检查。
13. 实现 build/lint/test/typecheck 质量门禁。
14. 实现前后端验证。
15. 实现 Review subagent。
16. 实现 draft PR 创建。
17. 实现项目地图更新建议。
