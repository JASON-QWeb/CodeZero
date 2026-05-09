# 系统架构设计

## 1. 总体架构

系统建议分为六层：

1. 入口层：接收 Issue、评论、人工按钮操作和 webhook。
2. 编排层：维护任务状态机、复杂度门禁、Agent 调度和重试策略。
3. Agent 层：负责 PRD、实现、测试、截图、Review 等具体智能任务。
4. 沙箱层：为每次任务创建隔离执行环境。
5. 产物层：保存 PRD、日志、截图、测试报告、patch、PR 链接。
6. Web 看板层：展示状态并提供人工控制。

大仓库场景下，沙箱会 clone 完整仓库，但 Agent 不阅读完整仓库。系统通过 codebase intelligence 层建立索引、执行 agentic search，并生成小型 ContextPack 供实现 Agent 使用。

## 2. 推荐技术栈

### 2.1 后端

- Node.js + TypeScript
- Fastify 或 NestJS
- PostgreSQL
- Redis + BullMQ
- GitHub App
- Prisma 或 Drizzle ORM

### 2.2 前端看板

- Next.js 或 Vite + React
- TanStack Query
- shadcn/ui 或 Radix UI
- WebSocket 或 Server-Sent Events

### 2.3 执行沙箱

沙箱能力按成熟度分三档：

- 开发模式：本机临时 workspace + git worktree + 受限环境变量。
- MVP 默认：Docker 容器 + volume 挂载 + 网络白名单。
- 高安全：Firecracker/microVM 或云端 ephemeral runner。

本项目建议 MVP 直接按 Docker 沙箱设计，实现时保留本机 worktree 开发模式。Agent 必须先在沙箱 clone 完整仓库，再建立索引、执行 agentic search、生成 ContextPack，并进入实现。

### 2.4 浏览器验证

- Playwright
- Chrome screenshots
- 桌面视口：1440x900
- 移动视口：390x844

## 3. 核心服务

### 3.1 Issue Ingest Service

职责：

- 接收 GitHub webhook。
- 拉取 Issue 正文、标签、评论、关联 PR 和附件。
- 标准化为 `IssueContext`。

### 3.2 Brainstorm Service

职责：

- 提取需求假设。
- 识别遗漏信息。
- 生成多个实现方向。
- 输出 `BrainstormReport`。

### 3.3 PRD Service

职责：

- 生成 PRD。
- 生成验收标准。
- 生成复杂度评分。
- 决定 `auto_execute` 或 `requires_human_review`。

### 3.4 Orchestrator

职责：

- 驱动状态机。
- 调度主 Agent 和 subagent。
- 管理重试、暂停、取消。
- 写入事件日志。

### 3.5 Sandbox Manager

职责：

- 创建隔离工作目录。
- checkout 指定分支。
- 安装依赖。
- 注入只读配置、prompt、skill。
- 限制网络、密钥和文件访问。
- 任务结束后归档产物并清理。

### 3.6 Agent Runtime

职责：

- 装载 prompt。
- 装载 skill。
- 调用模型。
- 读写沙箱文件。
- 运行测试命令。
- 上报事件。

### 3.7 Codebase Intelligence Service

职责：

- 建立文件路径、符号、语义和历史变更索引。
- 加载并索引项目业务 skill。
- 执行多轮 agentic search。
- 生成 ContextPack。
- 生成项目地图更新建议。

### 3.8 Verification Service

职责：

- 运行 build。
- 运行 lint。
- 运行测试。
- 运行 typecheck，如果项目存在对应命令。
- 收集覆盖率。
- 运行 Playwright 截图。
- 生成验证摘要。

### 3.9 Pull Request Service

职责：

- 为每个 Issue 创建独立任务分支。
- 提交 commit。
- 推送远端。
- 创建 draft PR。
- 写入 PR 描述和附件链接。

## 4. Agent 分工

### 4.1 主控 Agent

负责理解 PRD、规划实现、拆分任务、协调 subagent。

### 4.2 PRD Agent

负责从 Issue 生成 PRD、验收标准、复杂度评分和待确认问题。

### 4.3 Frontend Agent

负责 UI 实现、组件测试、页面验证、截图产物。

### 4.4 Backend Agent

负责服务端实现、单元测试、接口测试、数据迁移验证。

### 4.5 Test Agent

负责补充测试、运行测试、分析失败日志。

### 4.6 Review Agent

负责最终静态审查，输出风险、遗漏测试和 PR 说明建议。

PR 创建前必须运行 Review Agent。Review Agent 不直接修改代码，只基于 PRD、最小修改计划、diff、测试结果和截图产物做阻断判断。

Review Agent 还必须检查当前 PR 是否只包含当前 Issue 的改动，以及 build/lint/test/typecheck 是否通过。

## 5. 数据模型草案

### Task

- `id`
- `issue_provider`
- `issue_url`
- `repo`
- `base_branch`
- `status`
- `complexity_score`
- `requires_review`
- `created_at`
- `updated_at`

### Artifact

- `id`
- `task_id`
- `type`
- `path`
- `url`
- `metadata`
- `created_at`

### AgentRun

- `id`
- `task_id`
- `agent_role`
- `status`
- `model`
- `prompt_version`
- `skill_versions`
- `started_at`
- `finished_at`

### Event

- `id`
- `task_id`
- `level`
- `message`
- `metadata`
- `created_at`

## 6. 沙箱策略

### 6.1 文件隔离

每个任务使用独立工作目录：

```text
/sandboxes/{task_id}/repo
/sandboxes/{task_id}/artifacts
/sandboxes/{task_id}/logs
```

沙箱启动步骤：

1. 拉起容器。
2. clone 完整仓库。
3. checkout base branch。
4. 创建任务分支。
5. 加载平台 skill。
6. 加载项目 `.agent` 业务 skill。
7. 建立仓库索引，执行 agentic search，生成 ContextPack。
8. 执行 Agent workflow。

### 6.2 权限原则

- 默认不注入生产密钥。
- 默认禁止访问用户主目录。
- 默认只允许访问当前仓库、缓存目录和产物目录。
- 网络按任务类型开放，例如安装依赖、GitHub API、模型 API。

### 6.3 可复现性

每次运行记录：

- base commit
- branch name
- prompt version
- skill version
- model name
- command list
- environment image
- test result

## 7. Web 看板页面

### 7.1 任务列表

展示所有任务、状态、复杂度、Issue、PR、负责人和耗时。

### 7.2 任务详情

包含：

- PRD
- brainstorm 报告
- 状态流转时间线
- Agent 日志
- 测试输出
- 截图
- diff 摘要
- 人工操作按钮

### 7.3 配置页

包含：

- 仓库配置
- 复杂度阈值
- prompt 版本
- skill 开关
- sandbox 策略
- 测试命令模板

## 8. 推荐目录结构

```text
agent-prd-automation/
  apps/
    web/
    api/
  packages/
    orchestrator/
    agent-runtime/
    sandbox/
    github/
    verification/
    prompts/
    skills/
    project-context/
    codebase-intelligence/
    shared/
  infra/
    docker/
    migrations/
  docs/
```

## 9. OpenAI-Compatible Agent 配置

所有 Agent 使用统一 provider 抽象，不绑定单一供应商。

示例配置：

```yaml
providers:
  default:
    base_url: "https://api.openai.com/v1"
    api_key_env: "OPENAI_API_KEY"
    model: "${OPENAI_MODEL}"
    supports_tools: true
    supports_structured_output: true

agents:
  prd:
    provider: default
    model: "${OPENAI_MODEL}"
  implementation:
    provider: default
    model: "${OPENAI_MODEL}"
  review:
    provider: default
    model: "${OPENAI_MODEL}"
```
