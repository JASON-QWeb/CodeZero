# 核心技术

本文档记录 CodeZero 当前运行时使用的核心技术和各自职责。更完整的系统链路见 [架构说明](ARCHITECTURE.md)。

## TypeScript Monorepo

项目使用 pnpm workspace 和 Turbo 管理：

- `apps/api`：Fastify API。
- `apps/web`：Next.js 控制台。
- `apps/worker`：BullMQ worker。
- `packages/*`：按模型、编排、仓库上下文、沙箱、验证、持久化等能力拆包。

根命令：

```bash
pnpm dev
pnpm check
pnpm build
pnpm test
```

## Fastify API

API 是外部入口，主要职责是把产品动作变成 task facts 和 queue jobs：

- `/webhooks/github` 接收 GitHub 事件。
- `/tasks` 提供任务创建、查询、PRD 审批和 trace。
- `/repositories/:id/github-sync` 同步 Issue、评论和 PR feedback。
- `/repositories/:id/onboarding` 触发仓库 onboarding。
- `/repositories/:id/knowledge-graph/*` 管理 Understand-Anything 知识图。
- `/memories` 和 `/settings` 支撑控制台。

可选 API 鉴权由 `CODEZERO_API_TOKEN` 或 `API_AUTH_TOKEN` 开启。Web 控制台通过 `NEXT_PUBLIC_API_TOKEN` 发送 Bearer token。

## BullMQ 与 Redis

CodeZero 把长任务放到 BullMQ 队列中运行：

- API 创建 task 后投递 `issue-workflows` job。
- Worker 使用 `REDIS_URL` 连接 Redis。
- Worker 在执行前检查仓库级并发限制。
- 达到并发上限时，任务会延迟重排队。

这个边界让 API 保持短请求，也让 worker 重启后可以继续消费队列。

## LangGraph

LangGraph 是 Issue-to-PR 的 workflow runtime：

- `task.id` 是 graph `thread_id`。
- checkpoint 支持文件和 Postgres。
- PRD 审批通过 interrupt 暂停，再从同一个 thread 恢复。
- PR feedback 复用同一分支和 PR 进入迭代。

当前 graph 节点由 `packages/workflow-graph` 组织，业务阶段实现在 `packages/workflows/src/phases/`。

## AI SDK 模型层

`packages/model-runtime` 封装模型访问：

- 统一 provider registry。
- 支持 OpenAI-compatible provider。
- 支持 Anthropic、Gemini、xAI、Mistral、Groq 等原生 provider。
- 为 PRD、review、search planning 等 agent 提供结构化输出。
- 内置 timeout、rate limit、网络瞬断等瞬时失败重试。

AI SDK 不负责代码编辑。仓库修改由 OpenCode executor 完成。

## OpenCode Executor

实现阶段默认运行 OpenCode CLI：

```bash
OPENCODE_BIN="${OPENCODE_BIN:-opencode}"
"$OPENCODE_BIN" run \
  --agent build \
  --model "$CODEZERO_OPENCODE_MODEL" \
  --variant "${CODEZERO_OPENCODE_VARIANT:-minimal}" \
  --format json \
  --dangerously-skip-permissions \
  "Implement the CodeZero request in the attached prompt file." \
  --file="$CODEZERO_PROMPT_FILE"
```

CodeZero 会生成 prompt file，注入 Issue、已审批 Plan、ContextPack、项目规则、Memory、质量门反馈和 provider 配置。OpenCode 只负责沙箱内的探索、编辑和修复。

## 沙箱

`packages/sandbox` 提供两种执行环境：

- `worktree`：为每个 Issue 创建真实 Git worktree 和分支。
- `docker`：通过 Docker 执行命令，限制网络、权限、内存、CPU 和 PID。

实现完成后统一检查 diff 文件数和行数，超限会阻断 PR 发布。

## 仓库智能理解

`packages/codebase-intelligence` 和 `packages/project-context` 负责把仓库压缩成可执行上下文：

- CodeGraph 和符号索引。
- Navigation Graph。
- Hybrid Search。
- ContextPack。
- `.agent/project.md`。
- `.agent/rules/*`。
- `.agent/skills/*/SKILL.md`。
- 仓库 onboarding 文档。

这些信息会进入 Plan 生成和 OpenCode prompt。

## GitHub 集成

`packages/github` 负责 GitHub API：

- GitHub App installation token 优先。
- `GITHUB_TOKEN` 可作为 fallback。
- 支持 Issue、评论、分支、commit、PR 创建和 PR feedback 读取。
- GitHub sync 会扫描开放 Issue 和 PR feedback，并按仓库 trigger 配置入队。

CodeZero 默认创建 draft PR，不自动合并。

## 持久化与 Memory

Task repository 支持：

- 文件存储。
- Postgres 存储。

Memory store 当前是文件存储，支持容量限制、状态编辑、删除、裁剪和损坏文件隔离。Memory 只有审批后才会进入 approved 状态。

## 验证与可观测性

验证层覆盖：

- setup。
- build。
- lint。
- typecheck。
- unit test。
- frontend screenshot。
- review agent。
- diff limit。

可观测性输出包括：

- Task events。
- Trace replay。
- Artifacts。
- PR 正文中的验证证据和本地复现命令。

## 知识图集成

CodeZero 内置轻量仓库理解，并可集成官方 Understand-Anything：

- 生成 `.understand-anything/knowledge-graph.json`。
- 通过 API 查询 graph 状态。
- 通过 API 启动官方 dashboard。
- 控制台展示 repository onboarding 和 graph 入口。

需要先安装官方 Codex skill，或设置 `UNDERSTAND_ANYTHING_PLUGIN_ROOT` 指向本地插件路径。
