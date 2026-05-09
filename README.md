# Agent PRD Automation

这是一个用于讨论和落地的项目草案：从 Issue 需求进入，自动进行需求澄清与 brainstorm，生成 PRD；再由 Agent 在隔离沙箱中实现任务，补充测试与截图，最后提交 PR 给人审核。

## 当前状态

MVP 已可本地运行：支持 GitHub Issue webhook/手动导入、PRD 生成、人工 PRD 审批门禁、沙箱实现、质量门禁、Review subagent、推送分支并创建 draft PR。

验证命令：

```bash
pnpm check
```

快速配置：

```bash
pnpm install
cp .env.example .env
cp config/agents.example.yaml config/agents.yaml
cp config/repositories.example.yaml config/repositories.yaml
cp config/sandbox.example.yaml config/sandbox.yaml
```

然后编辑 `.env`、`config/repositories.yaml`，启动：

```bash
pnpm dev:api
pnpm dev:worker
pnpm dev:web
```

详见 [本地运行与真实接入](docs/OPERATIONS.md)。

## 当前文档

- [产品需求文档](docs/PRD.md)
- [系统架构设计](docs/ARCHITECTURE.md)
- [自动化流程蓝图](docs/WORKFLOW_BLUEPRINT.md)
- [Prompt 与 Skill 设计](docs/PROMPTS_AND_SKILLS.md)
- [Agent 架构与运行时](docs/AGENT_RUNTIME_ARCHITECTURE.md)
- [上下文压缩与最小修改原则](docs/CONTEXT_AND_MINIMAL_CHANGE.md)
- [大仓库理解、Agentic Search 与自进化项目地图](docs/CODEBASE_INTELLIGENCE.md)
- [Issue 隔离与 PR 质量门禁](docs/ISSUE_ISOLATION_AND_QUALITY_GATES.md)
- [项目脚手架蓝图](docs/PROJECT_SCAFFOLD.md)
- [本地运行与真实接入](docs/OPERATIONS.md)
- [已确认决策](docs/DECISIONS.md)
- [待确认问题](docs/OPEN_QUESTIONS.md)

## 一句话目标

把“用户在 Issue 中提出需求”转化为一条可审计、可回放、可人工介入的自动化研发流水线。

## 当前已确认方向

- Skill 分两层：平台统一 skill + 项目业务 skill。
- 看板第一版为单用户，不做权限系统。
- 所有 Agent 使用用户自行配置的 OpenAI-compatible 接口。
- Agent 先在 Docker 沙箱 clone 完整仓库，再建立索引、执行 agentic search、生成 ContextPack，并按最小修改原则实现。
- 每个 Issue 独立沙箱、独立分支、独立 draft PR。
- PR 创建前必须通过 build/lint/test/typecheck，并由 Review subagent 审核规范、风险和测试充分性。
