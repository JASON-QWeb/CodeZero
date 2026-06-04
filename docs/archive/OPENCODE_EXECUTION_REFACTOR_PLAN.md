# OpenCode 执行层改造计划

## 目标

本次改造将 CodeZero 收敛为控制平面，将 OpenCode 作为唯一代码执行层。CodeZero 负责需求入口、仓库配置、CodeGraph、仓库级 Skill/Rule、PRD/Plan、人工审批、沙箱、质量门、PR 创建和可观测性；OpenCode 只负责实现阶段的代码探索、编辑、测试修复。

## 架构边界

### CodeZero 控制平面

- 接收 GitHub webhook、手动导入 Issue、从自然语言需求创建 Issue。
- 根据仓库配置加载 `.agent/project.md`、`.agent/rules/*`、`.agent/skills/*/SKILL.md`。
- 构建 CodeGraph 索引、ContextPack、导航图和相关文件片段。
- 生成 PRD/Plan，并按仓库策略执行人工审批。
- 启动 OpenCode executor，收集 stdout/stderr JSON stream、diff、changed files 和 artifact。
- 运行质量门、截图验证、review agent，并在失败时触发 OpenCode repair loop。
- 负责 commit、push、创建或更新 draft PR。

### OpenCode 执行层

- 读取 CodeZero 生成的 prompt 和上下文。
- 在 sandbox/worktree 内探索文件、修改代码、运行必要命令。
- 根据质量门或 review 失败反馈进行修复。
- 不负责 commit、push、创建 PR、审批 PRD、修改任务状态或写入业务持久化状态。

## 删除范围

- 删除 `@agent/tool-gateway` 包和生产链路。
- 删除 `tools`、`policies` 配置 section。
- 删除仓库级 `permissions` 配置。
- 删除 provider 的 `supports_tools` 配置。
- 删除 `AgentDefinition.tools`、`AgentDefinition.guardrails` 字段。
- 不实现 Vercel AI SDK tool-calling。
- 不实现可执行 Skill manifest；Skill/Rule 继续作为 Markdown 约束文本。

## 保留并强化的能力

- `repository.project_skill_path` 和 `repository.project_rule_path` 保留。
- `codebase_intelligence.codegraph` 保留，并同时服务 Plan 阶段和 OpenCode MCP。
- `sandbox.implementation_executor` 保留，并明确表示 OpenCode executor 配置。
- `sandbox.limits.max_runtime_minutes` 作为 workflow 和 executor 的外层超时来源。
- `quality_gates` 保留，作为 OpenCode 完成后的权威验证。
- `memory` 保留，作为 ContextPack 和后续任务复用的上下文来源。

## 实施步骤

1. 配置收敛
   - 从 schema、loader、settings API、settings UI、示例配置中删除 `tools`、`policies`、`permissions` 和 `supports_tools`。
   - 更新 README 和架构文档，避免继续描述 Tool Gateway。

2. 执行链收敛
   - 删除 `packages/tool-gateway` 与 `packages/workflows/src/repository-policies.ts`。
   - 确保实现阶段唯一入口是 `runCodingCliExecutor()`。
   - 保留 OpenCode repair loop，并确保 OpenCode 不能 commit、push 或创建 PR。

3. Prompt 强化
   - 将 Issue、已审批 Plan、验收标准、仓库级 Skill/Rule、CodeGraph context、相关文件片段、失败反馈拆成明确段落。
   - `ContextPack.businessRules` 必须以人类可读约束段落注入 OpenCode prompt。
   - Plan 生成上下文必须包含项目级 Skill/Rule 和 CodeGraph context。

4. 需求创建 Issue
   - 在 GitHub client 中新增 `createIssue()`。
   - 新增 `POST /tasks/create-issue-from-requirement`。
   - API 根据自然语言需求生成标准 Issue 草稿，创建 GitHub Issue，并可选择自动入队。

5. 稳定性修复
   - 给 LangGraph workflow run 增加总超时。
   - 修复 Postgres checkpointer 全表读取问题，按 `thread_id`、`checkpoint_ns`、`checkpoint_id` 查询。
   - Trace 聚焦真实 workflow、OpenCode、质量门和 PR 事件，不再展示旧 Tool Gateway 指标。

## 验收标准

- 代码库中不存在 `@agent/tool-gateway` 包和依赖。
- 配置文件和设置页不再暴露 `tools`、`policies`、`permissions`、`supports_tools`。
- OpenCode prompt 明确包含仓库级 Skill/Rule、CodeGraph context 和质量门反馈。
- 可通过 API 从自然语言需求创建 GitHub Issue，并可选择入队。
- Postgres checkpointer 查询不再读取全表。
- workflow 总超时会产生失败事件并更新任务状态。
- 现有 Issue 到 PR 主流程、PRD 审批、质量门、PR 创建和项目级 Skill/Rule 管理不被破坏。

## 测试矩阵

- 配置加载：统一配置文件不包含旧 section 时可以加载；包含旧字段时应校验失败。
- 设置台：只展示 agents、repositories、sandbox、workflow graph、memory。
- OpenCode executor：成功 diff、无 diff、退出非 0、超时、质量门失败、repair loop。
- Plan 生成：上下文包含 issue、platform skills、项目级 Skill/Rule、CodeGraph context。
- Issue 创建：自然语言需求生成 Issue，GitHub 创建成功，`enqueue=true` 时创建 task。
- Checkpointer：`getTuple/list` 使用 thread 条件查询。
- Trace：summary 只包含 total spans 和 failed/blocked 计数。

## 回滚策略

如 OpenCode executor 在生产中出现不可接受的失败率，回滚方式是将 `sandbox.implementation_executor.command` 指向上一版可用 OpenCode 命令或临时禁用自动触发。不要恢复 Tool Gateway；该方向已从架构中移除。
