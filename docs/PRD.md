# 自动化 Agent 研发流程 PRD

## 1. 背景

当前从 Issue 到 PR 的研发流程通常包含需求澄清、方案设计、编码、测试、截图验证、PR 描述和人工 Review。这个过程有大量重复劳动，也存在几个常见问题：

- Issue 描述不完整，Agent 直接开工容易误做。
- 复杂需求缺少 PRD 或技术方案沉淀。
- 自动化编码缺少隔离沙箱，存在污染主工作区或误改文件的风险。
- 前端变更缺少截图、视觉验证和可追溯记录。
- 后端变更缺少稳定的单元测试和接口契约验证。
- 多 Agent 并行时缺少任务看板、状态追踪和人工中断能力。

本项目希望构建一个“Issue 驱动的 Agent 自动研发系统”，让 Agent 能先理解需求，再判断是否需要人审，最后在沙箱中完成实现并提交 PR。

## 2. 产品目标

### 2.1 核心目标

1. 自动读取 Issue，进行 brainstorm 和需求澄清。
2. 自动生成结构化 PRD 文档。
3. 根据复杂度和风险判断是否直接执行，或先请求人工审核 PRD。
4. 在隔离沙箱中启动实现 Agent 和若干 subagent。
5. 前端任务必须产出 Chrome 截图、视觉检查记录和单元测试。
6. 后端任务必须产出单元测试，必要时产出接口测试或迁移验证。
7. 通过 build/lint/test/typecheck 和 Review subagent 后自动创建 draft PR，并附带 PRD、实现摘要、测试结果、截图和风险说明。
8. draft PR 必须附带本地验证指令，让开发者可以快速 clone/checkout、安装依赖、运行质量门禁并启动页面验证。
9. 支持仓库级 GitHub Bot 触发策略，让不同仓库选择自动触发、`@` 触发、标签触发、手动触发或禁用。
10. 构建 Repo Navigation Graph，提升 Agent 在大仓库中定位入口、关联文件和测试的速度与准确度。
11. 提供 trace replay、eval、policy guardrails、tool permission 和安全扫描能力。
12. 提供 Web 看板展示任务状态、Agent 日志、产物、阻塞点和人工操作入口。
13. 建立记忆管理接口，沉淀项目地图、历史 PR 经验和可复用验证流程，但长期记忆更新必须可审核。

### 2.2 非目标

第一阶段不追求完全无人值守合并代码；合并仍由人完成。

第一阶段不做通用 CI/CD 平台替代品；只编排需求分析、实现、质量门禁验证和 draft PR 创建。

第一阶段不覆盖所有项目类型；优先支持 GitHub Issue、Git 仓库、Node/TypeScript 前端、常见后端测试命令。

第一阶段不重点处理企业私有代码出域治理、私有化模型部署和复杂脱敏策略；默认使用 DeepSeek / Qwen 等 OpenAI-compatible API 完成 Agent 任务。

## 3. 用户角色

### 3.1 产品或需求提出者

在 Issue 中描述需求，希望系统能自动补齐背景、边界和验收标准。

### 3.2 工程负责人

审核 PRD、技术方案、PR 风险和测试结果，决定是否继续或合并。

### 3.3 Agent 管理者

配置 prompt、skill、沙箱策略、复杂度阈值、仓库权限和执行预算。

## 4. 关键用户故事

### 4.1 Issue 到 PRD

当用户创建或标记一个 Issue 后，系统应自动读取标题、正文、标签、评论和关联文件，生成一份 PRD 草案。

PRD 必须包含：

- 背景与问题
- 目标与非目标
- 用户故事
- 验收标准
- 影响范围
- 风险与未知项
- 前后端分类
- 建议实现顺序
- 是否需要人工审核

### 4.2 复杂需求人工审核

当需求满足任意高风险条件时，系统不应直接进入实现，而应进入 `PRD_REVIEW_REQUIRED` 状态。

高风险条件包括：

- 需求涉及支付、权限、安全、数据删除、隐私、合规。
- 需要数据库迁移或跨服务改动。
- 预计改动文件超过阈值。
- 验收标准不清晰。
- Issue 中存在互相冲突的信息。
- Agent 置信度低于配置阈值。

### 4.3 自动实现

当 PRD 被批准或需求被判断为低风险时，系统在沙箱中创建执行环境：

- 在 Docker 沙箱中 clone 完整仓库，从目标 base branch 创建当前 Issue 的独立任务分支。
- 安装依赖或复用缓存。
- 注入 PRD、prompt、平台 skill、项目业务 skill 和由 agentic search 生成的 ContextPack。
- 按任务类型启动主实现 Agent。
- 根据需要启动 subagent，例如搜索 Agent、测试 Agent、前端截图 Agent、代码审查 Agent。
- 每个 Issue 独立沙箱、独立分支、独立 PR，不复用其他未合并 Issue 的 diff。

### 4.4 前端验证

前端任务完成后，系统必须：

- 运行 build。
- 运行 lint。
- 运行类型检查，如果项目存在对应命令。
- 启动本地开发服务器或 Storybook。
- 使用 Chrome/Playwright 打开目标页面。
- 保存桌面和移动视口截图。
- 运行单元测试。
- 如果配置了视觉回归基线，执行截图 diff。
- 将截图链接和测试摘要写入 PR。

### 4.5 后端验证

后端任务完成后，系统必须：

- 运行 build。
- 运行 lint。
- 运行相关单元测试。
- 运行类型检查，如果项目存在对应命令。
- 如果涉及 API，运行接口测试或契约测试。
- 如果涉及数据库，运行迁移 dry run 或本地迁移验证。
- 将测试结果写入 PR。

### 4.6 Web 看板

系统应提供 Web 看板，展示：

- 当前任务列表
- 每个任务状态
- Issue 链接
- PRD 文档
- 执行沙箱
- Agent 日志
- 当前 subagent
- 测试结果
- 前端截图
- PR 链接
- 人工审核、继续、暂停、取消、重试按钮

### 4.7 仓库级 GitHub Bot 触发

系统应允许每个仓库配置触发方式：

- `auto`：Issue 创建、重开或打标签后自动进入流程。
- `mention`：只有 Issue 评论包含仓库配置的 `@bot` 才触发。
- `label`：只有包含 allowlist 标签才触发。
- `manual`：只能通过 Web 看板或 API 手动导入。
- `disabled`：仓库安装 Bot 但暂停执行。

触发策略必须写入事件日志，便于解释“为什么这个 Issue 被 Agent 接手”。

### 4.8 PR 本地验证

Agent 创建 draft PR 时，PR 描述必须包含：

- GitHub CLI 验证路径：`gh repo clone` + `gh pr checkout`。
- plain Git 验证路径：`git clone` + `git fetch origin <branch>` + `git checkout`。
- install、build、lint、typecheck、test 命令。
- 前端任务的 dev server 和截图 URL。
- base branch、base commit、agent branch、sandbox image。
- 截图、测试报告、Review subagent artifact 链接。

Review subagent 应检查这些说明是否足以让开发者快速复现 Agent 的验证过程。

### 4.9 记忆与项目地图

系统应把每次任务的高价值经验沉淀为可审核的记忆更新建议：

- semantic project memory：业务术语、模块关系、测试指南。
- episodic memory：历史 Issue/PR 摘要、失败和人工反馈。
- procedural memory：某类任务的验证流程和修复 playbook。

长期记忆不能静默写入，必须以 artifact 或 PR 内容形式让人审核。

### 4.10 Repo Navigation Graph

系统应为每个仓库维护代码导航图，帮助 Agent 快速定位：

- 页面入口、API endpoint、worker、CLI command。
- 相关组件、service、model、schema、migration。
- import/export 和调用链。
- 源文件对应测试。
- CODEOWNERS 和高风险目录。
- 历史 PR 中经常一起修改的文件。
- 与业务术语和 memory 相关的模块。

每个任务应产出 `navigation-route.json`，说明当前 Issue 的入口、必读文件、相关测试、排除区域和选择理由。

### 4.11 可观测、评估与治理

系统应支持：

- Trace Replay：回放状态转移、LLM call、tool call、memory hit、guardrail decision。
- Golden Issue Eval：用固定 Issue fixtures 回归评估 PRD、ContextPack、导航路线、Review 和 PR body。
- MCP Tool Gateway：统一管理工具 schema、权限、timeout、redaction 和审计。
- Policy-as-Code：通过配置阻断危险文件、危险命令和高风险领域。
- Security Scan：secret scan、dependency audit、SAST、prompt injection scan。
- Model Router：按任务复杂度、风险和预算选择模型，并记录 token、成本和耗时。

## 5. 状态机

建议状态如下：

1. `ISSUE_RECEIVED`
2. `CONTEXT_COLLECTING`
3. `BRAINSTORMING`
4. `PRD_DRAFTED`
5. `PRD_REVIEW_REQUIRED`
6. `PRD_APPROVED`
7. `SANDBOX_PREPARING`
8. `ISSUE_BRANCH_CREATED`
9. `CODEBASE_INDEXING`
10. `AGENTIC_SEARCHING`
11. `CONTEXT_PACK_CREATED`
12. `IMPLEMENTING`
13. `QUALITY_GATES_RUNNING`
14. `SUBAGENT_REVIEWING`
15. `PR_CREATING`
16. `HUMAN_REVIEW`
17. `DONE`
18. `BLOCKED`
19. `FAILED`
20. `CANCELLED`

## 6. 复杂度评分

系统应给每个 Issue 计算复杂度分数 `0-100`。

建议维度：

- 需求清晰度：0-20
- 改动范围：0-20
- 安全/权限/数据风险：0-20
- 测试可验证性：0-15
- 跨模块/跨服务程度：0-15
- Agent 置信度：0-10

建议门禁：

- `0-39`：可自动执行。
- `40-69`：生成 PRD 后等待人工确认。
- `70-100`：必须人工拆分或补充方案，不自动编码。

## 7. MVP 范围

### 7.1 必须有

- GitHub Issue webhook 或手动导入 Issue。
- PRD 自动生成。
- 复杂度评分和人工审核门禁。
- 沙箱工作区创建。
- Agentic search 和 ContextPack。
- Repo Navigation Graph 和 navigation route artifact。
- 每个 Issue 独立分支和独立 PR。
- 主 Agent 执行。
- 前端截图验证。
- 后端测试验证。
- build/lint/test/typecheck 质量门禁。
- draft PR 自动创建。
- Web 看板。
- PR 本地验证指令。
- 记忆架构与 memory/project-map update artifact。
- Trace Replay 和基础 eval harness。
- Policy-as-Code 和安全扫描门禁。

### 7.2 可以延后

- 多仓库联动。
- 自动拆分 Epic。
- 自动静默写入长期记忆系统。
- 视觉回归基线管理。
- 生产环境部署审批。
- 自动合并。

## 8. 成功指标

- 低风险 Issue 自动生成 PR 的成功率。
- 人工修改 PRD 的比例。
- 自动 draft PR 被接受的比例。
- 每个任务平均耗时。
- 因需求理解错误导致的返工率。
- 自动测试覆盖率与失败定位准确率。
- 人工审核者对 PR 摘要和截图材料的满意度。
- 开发者按 PR 本地验证指令成功复现的比例。
- memory proposal 被人工接受并复用的比例。

## 9. 关键风险

- Agent 误判需求复杂度，导致过早执行。
- 沙箱权限过大，误触外部资源。
- 前端截图无法代表真实交互质量。
- 测试命令在不同仓库差异过大。
- Skill 和 prompt 版本不可追踪，导致结果不可复现。
- Web 看板只展示状态但无法解释 Agent 决策。
- 长期记忆过期或被过度泛化，误导 Agent 修改错误区域。

## 10. 推荐第一阶段交付

第一阶段建议做一个“多仓库配置、单任务单仓库、GitHub Issue、人工确认 PRD、Docker 沙箱执行、质量门禁、Review subagent、自动 draft PR、本地验证指令”的闭环。

默认策略可以保守一些：只要复杂度超过 40，就先要求人审 PRD。这样能先保证系统可信，再逐步放宽自动执行范围。
