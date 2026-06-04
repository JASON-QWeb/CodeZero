# 重构计划归档

本文档记录 AI SDK、LangGraph、OpenCode 三层架构重构的历史计划，以及重构后应继续保持的边界。当前架构请以 [../ARCHITECTURE.md](../ARCHITECTURE.md) 为准。

## 重构目标

实现后需要保持：

- 一份 provider 配置同时编译为 AI SDK 和 OpenCode runtime 视图。
- AI SDK 作为 PRD、review、context、routing 和受控平台工具的模型层。
- LangGraph 作为 durable workflow runtime。
- OpenCode 作为默认且唯一的代码执行层。
- CodeZero 继续拥有持久化、事件、artifact、沙箱、GitHub 集成和质量门。

## 不变量

不要破坏这些契约：

- 一个 GitHub Issue 对应一个 task、一个持久沙箱、一个分支和一个 PR。
- PRD 审批恢复同一个 task 和沙箱。
- PR feedback 更新同一个 PR 分支。
- 实现阶段不使用 JSON patch、write-file action 或自研编辑循环。
- API key 保持在环境变量中。
- 面向用户的文案使用 CodeZero；只有本地执行配置才直接说明 OpenCode。

## 工作包 1：统一 Provider Runtime

目标是建立 provider runtime 模块，作为模型配置的单一事实源。

建议结构：

```text
packages/model-runtime/
  src/config.ts
  src/ai-sdk-registry.ts
  src/model-router.ts
  src/opencode-config.ts
  src/structured-agent.ts
```

任务：

- 将 provider selection 从 `packages/workflows/src/agent-factory.ts` 移出。
- 用 AI SDK registry-backed call 替换手写 `OpenAICompatibleProvider`。
- 增加 `generateStructuredAgentOutput(agent, schema, context)`。
- 保持 zod schema 作为 PRD 和 review 输出权威。
- 将 `buildOpenCodeProviderConfig` 从 `coding-executor.ts` 移到新的 provider runtime。
- 增加测试，证明一份 provider 配置能同时创建 AI SDK model 和 OpenCode config artifact。

验收：

- PRD 和 review agent 不再调用手写 `/chat/completions`。
- Runtime 通过同一个 `providers.default` block 支持 AI SDK 原生 provider 和 OpenAI-compatible gateway。
- 拆分配置文件被删除，只读取 `config/codezero.yaml`。
- OpenCode config 生成不把原始 API key 写入 artifact。

## 工作包 2：LangGraph State Model

增加 graph state 包，同时保留可复用的 workflow step helper。

建议结构：

```text
packages/workflow-graph/
  src/state.ts
  src/events.ts
  src/nodes/
  src/graph.ts
  src/checkpointer.ts
```

任务：

- 定义 `CodeZeroGraphState`。
- 将当前 `Task` 字段映射到 graph state。
- 使用 `task.id` 作为 LangGraph `thread_id`。
- 生产使用 Postgres checkpointer，本地测试使用 memory 或 sqlite checkpointer。
- 增加 event helper，将 graph callback 转换成现有 `TaskEvent`。

验收：

- 测试可以从现有 task 创建 graph state，并写入、读取 checkpoint。
- Graph state 可以通过 task id 恢复。
- Event 输出继续兼容 Run Console。

## 工作包 3：将现有 Workflow 方法包成节点

第一步不重写业务行为，只把当前 workflow 方法包到 node function 后面。

初始节点映射：

```text
prepare_sandbox                 -> 现有 prepareSandbox 行为
build_repository_intelligence   -> 现有 codegraph/navigation/memory/context 行为
draft_prd                       -> 通过 AI SDK 执行现有 PRD agent 行为
run_opencode_executor           -> 现有 coding executor 行为
run_quality_gates               -> 现有 verification 行为
run_review_agent                -> 通过 AI SDK 执行现有 review 行为
create_or_update_pr             -> 现有 PR 创建或更新行为
```

任务：

- 必要时将 `IssueWorkflowRunner` 的 private method 提取为可复用 service。
- 保留 `IssueWorkflowRunner` 作为 workflow step service，外部入口切到 `packages/workflow-graph`。
- 保持 artifact 和 event name 不变。

验收：

- 现有测试可以按区域迁移。
- 第一版 graph-backed run 不要求改变产品行为。

## 工作包 4：Human Interrupts

将人工等待状态移入 LangGraph interrupt。

中断点：

- PRD review required。
- Policy approval required。
- Manual retry 或 unblock。
- PR feedback received。

任务：

- 将 dashboard PRD approval 转成 graph resume。
- 将 GitHub `approve prd` 评论转成 graph resume。
- 将 PR feedback sync 转成带 feedback payload 的 graph resume。
- 在 task events 和 artifact 中保存 interrupt metadata。

验收：

- 审批不会入队重复的完整 workflow。
- Feedback 恢复同一个 task thread、sandbox、branch 和 PR。

## 工作包 5：Repair Loop Edges

将 self-check loop 移入 graph conditional edges。

边：

- quality gate failure 且可修复：回到 `run_opencode_executor`。
- quality gate failure 且环境问题：进入 `blocked`。
- review failure 且可修复：回到 `run_opencode_executor`。
- review failure 且重复或无进展：进入 `blocked`。
- review approved：进入 `create_or_update_pr`。

任务：

- 将 repair budget 放入 graph state。
- 每次 executor attempt 保存为 artifact group。
- 每次 OpenCode run 前保留 checkpoint。
- executor 非零退出或无 diff 时恢复 pre-run diff。

验收：

- Worker 重启后 graph 可以从最后完成节点恢复。
- checkpoint restore 后不会不必要地重跑成功节点。

## 工作包 6：Worker 切换

BullMQ 保持为 job trigger，不承担 workflow brain。

任务：

- 将 worker job 从 `run entire IssueWorkflowRunner` 改为 `startOrResumeGraph(taskId)`。
- 保留 graph invocation 前的仓库并发检查。
- 将 graph-run id 和 thread id 写入 job metadata。
- 让 retry 恢复 graph state，而不是从头开始。

验收：

- 实现阶段 worker 重启后会恢复 graph，而不是重建整个 task。
- 仓库容量不足时延迟重排队的行为保持兼容。

## 工作包 7：清理旧 Runtime 路径

Graph-backed workflow 测试通过后，删除或收缩过时抽象。

删除或收缩：

- AI SDK 外的手写 provider probing。
- 旧 JSON action 实现循环。
- workflow 专用模型选择 helper。
- 重复的 provider 到 OpenCode config 生成逻辑。
- 描述 Tool Gateway 作为编码编辑循环的文档或注释。

保留：

- OpenCode executor。
- sandbox manager。
- verification service。
- persistence repositories。
- GitHub service。
- memory proposal flow。
- codebase intelligence services。

## 验证清单

重构完成前需要确认：

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- golden issue eval 仍可运行。
- PRD approval 恢复同一个 thread。
- OpenCode implementation 产生 events 和 diff artifacts。
- quality gate failure 带反馈回到 OpenCode。
- review failure 带反馈回到 OpenCode。
- PR feedback 更新同一个 PR。
- generated artifact 不保存原始 API key。
- README 和 docs 只描述 AI SDK、LangGraph、OpenCode 架构。

## 建议文件归属

```text
packages/model-runtime/       AI SDK registry、model router、OpenCode config compiler
packages/workflow-graph/      LangGraph state、nodes、edges、checkpointer、callbacks
packages/workflows/           可复用 workflow step helper 和 OpenCode executor integration
packages/sandbox/             sandbox 和 process execution primitives
packages/verification/        quality gates 和 screenshots
apps/worker/                  graph start/resume trigger
apps/api/                     恢复 graph interrupt 的 dashboard 和 GitHub action
```
