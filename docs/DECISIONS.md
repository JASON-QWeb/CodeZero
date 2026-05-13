# 已确认决策

## 1. Skill 策略

Skill 分为两层：

### 1.1 平台统一 Skill

由平台统一维护，适用于所有仓库。

第一批内置 skill：

- `brainstorm-requirements`：从 Issue 做需求发散、澄清、风险识别。
- `draft-prd`：生成 PRD、验收标准、复杂度评分。
- `repo-context-compress`：基于仓库索引和 agentic search 生成 ContextPack。
- `minimal-change-planner`：根据 PRD 生成最小修改计划。
- `frontend-verification`：前端截图、控制台错误检查、单元测试。
- `backend-verification`：后端单元测试、类型检查、接口测试建议。
- `pr-compliance-review`：审核 PR 是否符合规范。
- `risk-review`：审核 diff 风险、遗漏测试、破坏性改动。
- `pr-writer`：生成 PR 标题、描述、测试摘要和截图索引。

### 1.2 项目业务 Skill

每个项目可以维护自己的业务 skill，用于补充：

- 业务领域术语。
- 核心业务流程。
- 权限、计费、数据模型、状态机。
- 禁止修改区域。
- 项目代码规范。
- 测试命令和截图入口。
- 历史架构决策。

建议项目内目录：

```text
.agent/
  project.md
  business/
    billing.md
    auth.md
    order-flow.md
  skills/
    project-business-rules/
      SKILL.md
    frontend-pages/
      SKILL.md
    backend-contracts/
      SKILL.md
```

## 2. 看板策略

第一版看板为单用户内部看板，不做权限系统。

必须支持：

- 任务状态。
- PRD 审核。
- Agent 日志。
- 沙箱信息。
- 测试结果。
- 前端截图。
- PR 链接。
- 暂停、继续、取消、重试。

## 3. Agent 接口策略

所有 Agent 都由用户自行配置 OpenAI-compatible 接口。

配置项包括：

- `base_url`
- `api_key`
- `model`
- `temperature`
- `max_tokens`
- `reasoning_effort`
- `timeout`
- `tool_calling_enabled`
- `structured_output_enabled`

不同角色可以配置不同模型：

- PRD Agent
- Main Implementation Agent
- Explorer Subagent
- Frontend QA Subagent
- Backend Test Subagent
- Review Subagent

## 4. 沙箱策略

Agent 必须先在沙箱中 clone 完整代码仓库，再进行分析和实现。

默认流程：

1. 创建任务沙箱。
2. clone repo。
3. checkout base branch。
4. 创建任务分支。
5. 扫描仓库结构。
6. 读取项目业务文档和 skill。
7. 建立仓库索引，执行 agentic search，生成 ContextPack。
8. 生成最小修改计划。
9. 执行实现。
10. 运行验证。
11. Review subagent 审核。
12. 创建 draft PR。

## 5. PR 审核策略

提交 PR 前必须经过 subagent 审核。

审核内容：

- 是否满足 PRD。
- 是否符合最小修改原则。
- 是否存在无关重构。
- 是否缺测试。
- 是否存在安全、权限、数据风险。
- 前端是否有截图和测试。
- 后端是否有单元测试。
- PR 描述是否完整。

审核不过时不创建 PR，进入 `BLOCKED_REVIEW_FAILED` 或 `IMPLEMENTATION_REVISION`。

## 6. Issue 隔离策略

每个 Issue 必须独立沙箱、独立分支、独立 PR。

后一个 Issue 默认不能基于前一个 Issue 的未合并分支，也不能复用前一个任务沙箱中的 diff。只有在人明确声明依赖关系时，才允许基于另一个未合并 PR 工作。

## 7. PR 前质量门禁

创建 PR 前必须通过：

- build。
- lint。
- 单元测试。
- 类型检查，如果项目存在对应命令。
- 前端截图，如果是前端任务。
- Review subagent 审核。

任何门禁失败都不能静默跳过。Agent 可以自动修复，但超过重试上限后必须进入阻断状态。

## 8. GitHub Bot 触发策略

项目产品形态确认为 GitHub Bot，优先服务 GitHub Issue 到 draft PR 的闭环。

触发策略需要支持仓库级配置：

- `auto`：匹配 Issue 事件后自动执行。
- `mention`：只有评论包含仓库配置的 `@bot` mention 才执行。
- `label`：只有符合 label allowlist 才执行。
- `manual`：只能通过 Web 看板或 API 手动导入。
- `disabled`：仓库安装但暂停执行。

第一版代码可以继续使用全局 `AGENT_TRIGGER_MENTION`，但目标配置应进入 `repositories.yaml`，避免不同仓库只能共享同一个触发策略。

## 9. PR 本地验证策略

Agent 创建 draft PR 时，PR 描述必须包含开发者本地验证说明。

至少包含：

- GitHub CLI 路径：`gh repo clone` + `gh pr checkout`。
- plain Git 路径：`git clone` + `git fetch origin <agent-branch>` + `git checkout`。
- install command。
- build/lint/typecheck/test command。
- 前端 dev server command，如果涉及前端。
- base branch、base commit、agent branch、sandbox image。
- 截图和测试 artifact 链接。

Review subagent 必须检查 PR 描述是否足以让开发者快速复现 Agent 的验证过程。

## 10. 记忆管理策略

记忆管理确认为本项目的核心架构能力之一。

分层：

- workflow memory：任务状态、事件、artifact，是事实来源。
- session memory：当前 run 或修复循环内的短期上下文。
- semantic project memory：项目地图、业务术语、模块关系和测试指南。
- episodic memory：历史 Issue/PR 执行经验。
- procedural memory：可复用流程、playbook 和 skill 更新建议。

长期记忆不能静默修改。Agent 只能生成 memory/project-map update artifact，默认由 Review subagent 和人审核后才进入可信项目记忆。

## 11. Repo Navigation Graph 策略

Repo Navigation Graph 确认为大仓库能力的核心模块。

导航图必须覆盖：

- 文件、目录、生成文件和测试文件。
- 符号、组件、函数、route、API handler。
- import/export、调用链和组件渲染关系。
- 源文件到测试文件。
- 业务术语到模块。
- CODEOWNERS 和高风险目录。
- 历史 PR changed-with 关系。
- memory 到模块或符号的链接。

每个任务应生成 `navigation-route.json`，作为 ContextPack 和最小修改计划的输入。Review subagent 必须检查实际 diff 是否偏离导航路线。

## 12. 可观测、评估、工具与治理策略

以下能力纳入长期路线：

- Trace Replay / Run Debugger。
- Golden Issue Eval Harness。
- MCP Tool Gateway。
- Policy-as-Code Guardrails。
- Repository Onboarding Agent。
- Tool Permission UI。
- Multi-Agent File Ownership / Conflict Manager。
- Cost / Latency / Model Router。
- Prompt / Skill Registry。
- Security Scanning Pipeline。

这些能力的优先级和产物见 [ADVANCED_AGENT_CAPABILITIES.md](ADVANCED_AGENT_CAPABILITIES.md)。

## 13. 模型与国产 API 策略

当前施工默认面向国产 OpenAI-compatible API。

优先目标模型：

- `deepseek-v4`
- `qwen3.5`

模型接入原则：

- provider 仍统一走 OpenAI-compatible abstraction。
- 模型只输出结构化 JSON artifact 或 JSON action。
- 工具执行由 Tool Gateway 和 Orchestrator 完成。
- 如果 provider 原生 tool calling 稳定，可以启用 native tool 模式。
- 如果 provider tool calling 不稳定，回退到 JSON action + schema validation + repair parser。

当前阶段不重点处理：

- 企业私有代码出域治理。
- 私有化模型部署。
- 复杂脱敏策略。

仍保留：

- secret scan。
- dangerous path scan。
- policy-as-code。
- quality gates。

## 14. 施工路线

后续代码施工按 [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md) 推进。
