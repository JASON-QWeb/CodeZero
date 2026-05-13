# Agent PRD Automation

一个面向真实仓库的 GitHub Agent Bot：从 Issue 或 `@agent` 评论触发，自动生成 PRD，在隔离沙箱中完成最小变更，通过质量门禁和 Review subagent 后创建 draft PR，并在 PR 中附上开发者可直接本地验证的 checkout、安装、测试和启动指令。

这个项目的目标不是做一个“prompt 生成代码”的 demo，而是展示一套更接近生产级 Agent 研发系统的架构：durable workflow、multi-agent orchestration、codebase intelligence、memory management、sandbox execution、guardrails、traceable artifacts 和 human-in-the-loop。

## 当前状态

MVP 已可本地运行：支持 GitHub Issue webhook/手动导入、仓库级触发策略、PRD 生成、人工 PRD 审批门禁、Repo Navigation Graph MVP、导航路线与 approved memory 驱动的 ContextPack、Tool Gateway + JSON action fallback、Trace Replay API、Run Console 看板、Settings Console 配置中心、Memory Inbox 审核、Golden Issue Eval CLI/CI、Repository Onboarding、沙箱实现、质量门禁、Review subagent、PR Local Verification Writer、推送分支并创建 draft PR。

验证命令：

```bash
pnpm check
pnpm eval:golden
```

快速配置：

```bash
pnpm install
cp .env.example .env
cp config/agents.example.yaml config/agents.yaml
cp config/repositories.example.yaml config/repositories.yaml
cp config/sandbox.example.yaml config/sandbox.yaml
cp config/policies.example.yaml config/policies.yaml
cp config/tools.example.yaml config/tools.yaml
```

然后编辑 `.env`，启动服务后可在 WebUI 的 Settings Console 里继续配置模型、仓库、工具权限和 policy：

```bash
pnpm dev:api
pnpm dev:worker
pnpm dev:web
```

详见 [本地运行与真实接入](docs/OPERATIONS.md)。

## 当前文档

- [简历项目审核与改进路线图](docs/PORTFOLIO_ROADMAP.md)
- [高级 Agent 能力矩阵](docs/ADVANCED_AGENT_CAPABILITIES.md)
- [代码施工路线图](docs/IMPLEMENTATION_ROADMAP.md)
- [产品需求文档](docs/PRD.md)
- [系统架构设计](docs/ARCHITECTURE.md)
- [自动化流程蓝图](docs/WORKFLOW_BLUEPRINT.md)
- [Prompt 与 Skill 设计](docs/PROMPTS_AND_SKILLS.md)
- [Agent 架构与运行时](docs/AGENT_RUNTIME_ARCHITECTURE.md)
- [Agent 记忆管理架构](docs/MEMORY_ARCHITECTURE.md)
- [Repo Navigation Graph](docs/REPO_NAVIGATION_GRAPH.md)
- [上下文压缩与最小修改原则](docs/CONTEXT_AND_MINIMAL_CHANGE.md)
- [大仓库理解、Agentic Search 与自进化项目地图](docs/CODEBASE_INTELLIGENCE.md)
- [Issue 隔离与 PR 质量门禁](docs/ISSUE_ISOLATION_AND_QUALITY_GATES.md)
- [项目脚手架蓝图](docs/PROJECT_SCAFFOLD.md)
- [本地运行与真实接入](docs/OPERATIONS.md)
- [已确认决策](docs/DECISIONS.md)
- [待确认问题](docs/OPEN_QUESTIONS.md)

## 一句话目标

把“用户在 Issue 中提出需求”转化为一条可审计、可回放、可人工介入的自动化研发流水线。

## 作品集亮点

- GitHub Bot 形态：支持 webhook、Issue 评论触发，目标支持每个仓库配置 `auto`、`mention`、`label`、`manual` 或 `disabled`。
- Agent 运行时：OpenAI-compatible provider、结构化输出、角色化 Agent、Review subagent 和 guardrail 门禁。
- WebUI 配置：Settings Console 可编辑并校验 `agents.yaml`、`repositories.yaml`、`tools.yaml`、`policies.yaml` 和 `sandbox.yaml`，覆盖模型、仓库、触发方式、仓库级工具权限、Policy 和沙箱，并可点击 Test 验证模型 API key/base URL/model 是否可用。
- 模型路由：每个 Agent step 可指定 provider，implementation/review 还支持按 PRD complexity score 选择 low/medium/high provider。
- 记忆管理：已有 `@agent/memory`、memory proposal artifact、episodic/procedural 记忆草案、approved-only 本地 Memory Store，并把 approved memory 接入 ContextPack。
- 仓库导航图：为 Agent 构建入口、符号、依赖、调用链、测试、ownership 和历史变更图，提升大仓库读代码速度和准确度。
- 大仓库上下文工程：全仓库 clone 但不全仓库阅读，通过索引、agentic search、证据评分生成小型 ContextPack。
- 可验证 PR：PR 描述会自动包含 GitHub CLI 和 plain Git 两套本地验证指令，以及 base commit、agent branch、sandbox image、build/lint/test/typecheck、截图、风险说明。
- 可观测与可评估：已有 Trace Replay API、Run Console、Golden Issue Eval Harness/CLI、GitHub Actions CI report、MCP-style Tool Gateway 和基础 policy-as-code。
- 仓库接入：`pnpm onboard:repo` 可对新仓库生成 `.agent/project.md`、module map、route map、testing guide、repository config 和 policy 建议。

## 当前已确认方向

- Skill 分两层：平台统一 skill + 项目业务 skill。
- 看板第一版为单用户，不做权限系统。
- 所有 Agent 使用用户自行配置的 OpenAI-compatible 接口。
- 默认面向 DeepSeek / Qwen 等国产 OpenAI-compatible API，模型只输出结构化 action，工具执行由平台 Tool Gateway 负责；简单任务可路由到便宜/快速模型，复杂任务可路由到强模型。
- Agent 先在 Docker 沙箱 clone 完整仓库，再建立索引、执行 agentic search、生成 ContextPack，并按最小修改原则实现。
- 每个 Issue 独立沙箱、独立分支、独立 draft PR。
- PR 创建前必须通过 build/lint/test/typecheck，并由 Review subagent 审核规范、风险和测试充分性。
- 当前阶段不重点处理企业私有代码出域治理、私有化模型部署和复杂脱敏策略。

## 后续增强

1. 增加审批恢复、tool input schema 和 security scanning。
2. 对 PRD、最小修改计划、Review 结论增加更细粒度 eval assertion。
3. 后续增强 Repo Navigation Graph，引入更精确的 AST/SCIP 适配器。
4. 增加 model router 的成本、延迟和质量对比面板。

详细施工顺序见 [代码施工路线图](docs/IMPLEMENTATION_ROADMAP.md)。
