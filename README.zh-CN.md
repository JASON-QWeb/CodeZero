<div align="center">

<br />

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://img.shields.io/badge/CodeZero-000000?style=for-the-badge&logo=github&logoColor=white&labelColor=000000">
  <img alt="CodeZero" src="https://img.shields.io/badge/CodeZero-000000?style=for-the-badge&logo=github&logoColor=white&labelColor=000000">
</picture>

# CodeZero

### 无需人工编码，从需求到代码落地的自动化工作流

**把产品意图推进成可审核、可验证的 Pull Request —— 全程自主执行。**

[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![LangGraph](https://img.shields.io/badge/LangGraph-编排引擎-1C3C3C?style=flat-square&logo=langchain&logoColor=white)](https://langchain-ai.github.io/langgraph/)
[![AI SDK](https://img.shields.io/badge/Vercel_AI_SDK-驱动-000000?style=flat-square&logo=vercel&logoColor=white)](https://sdk.vercel.ai/)
[![pnpm](https://img.shields.io/badge/pnpm-monorepo-F69220?style=flat-square&logo=pnpm&logoColor=white)](https://pnpm.io/)

[English](README.md) · **中文** · [文档](docs/README.md)

---

**⚡ 写一个 Issue → 拿到一个验证过的 PR。就这么简单。**

</div>

<br />

## 🎬 演示

<!-- 
  GIF Demo 占位 — 请用实际的 GIF 路径或 URL 替换下方注释。
  示例：![描述](./assets/demo-xxx.gif)
-->

<div align="center">

<!-- ![从 Issue 到 PRD 自动生成](./assets/demo-issue-to-prd.gif) -->
> 🎥 **Issue → PRD 自动生成** — _GIF 即将放出_

<!-- ![实时 Agent 编码进度](./assets/demo-live-progress.gif) -->
> 🎥 **实时 Agent 编码进度** — _GIF 即将放出_

<!-- ![带验证证据的 Draft PR](./assets/demo-draft-pr.gif) -->
> 🎥 **带验证证据的 Draft PR 自动创建** — _GIF 即将放出_

</div>

---

## ✨ 为什么选择 CodeZero？

大多数 AI 编码工具止步于**代码生成**。CodeZero 覆盖的是**整条工程链路** —— 从产品意图到一个经过验证、可以 review 的 Pull Request。

<table>
<tr>
<td width="50%" valign="top">

### 🔴 没有 CodeZero
- 写工单 → 手动拆解需求
- 切换到 IDE → 翻找需要改哪些文件
- 写代码 → 跑测试 → 修 bug → 反复
- 开 PR → 等 review → 改 → 反复
- **一个功能花几小时到几天**

</td>
<td width="50%" valign="top">

### 🟢 有了 CodeZero
- 用自然语言写一个 GitHub Issue
- CodeZero 阅读仓库、生成 PRD、等待审批
- Agent 在隔离沙箱里编码，进度实时可见
- 自动跑验证、创建带证据的 draft PR
- **一个功能只需几分钟到几小时**

</td>
</tr>
</table>

---

## 🚀 它做了什么

<table>
<tr>
<td align="center" width="33%">
<h3>📋 规划</h3>
<p>把 Issue 转化为结构化 PRD/Plan 文档：包含验收标准、风险分析、文件范围、测试项和命令。</p>
</td>
<td align="center" width="33%">
<h3>🤖 实现</h3>
<p>AI 编码 Agent 在持久沙箱中实现代码变更，stdout/stderr 实时流式推送到 Run Console。</p>
</td>
<td align="center" width="33%">
<h3>✅ 交付</h3>
<p>执行 build、lint、test、typecheck 和 review 门禁 —— 然后创建带验证证据和本地复现步骤的 draft PR。</p>
</td>
</tr>
</table>

---

## 🏗️ 核心能力

| 能力 | 说明 |
|:---|:---|
| **Issue → PRD → PR** | GitHub Issue 自动转化为结构化执行文档、验证后的 diff 和 draft PR |
| **LangGraph 编排** | 可 checkpoint 的图节点，支持审批中断和可恢复的修复循环 |
| **AI SDK 模型层** | 统一 provider registry，处理 PRD、review、context、validation 和 routing 调用 |
| **实时 Agent 进度** | OpenCode 输出实时捕获为看板事件，随时查看 coding executor 在做什么 |
| **OpenCode-First 实现** | 主实现流程交给 CLI executor，不再依赖传统 JSON 文件写入 |
| **仓库智能理解** | CodeGraph + Navigation Graph + ContextPack 在改代码前收敛修改范围 |
| **持久 Task Sandbox** | 每个 Issue 一个沙箱 —— 跨审批、反馈迭代和重跑周期始终复用 |
| **Human-in-the-Loop** | PRD 审批、Policy 门禁、Review subagent 和 memory proposal 保持人可控 |
| **多供应商支持** | OpenAI、Anthropic、Gemini、xAI、Mistral、Groq —— 不同 agent 可路由到不同模型 |
| **操作台完整** | Run Console、Settings Console、Memory Inbox、Trace Replay API、Golden Issue Eval CLI |

---

## 🔄 工作流程

```
  ┌─────────────┐     ┌──────────────┐     ┌──────────────┐     ┌─────────────┐
  │   触发任务   │────▶│   分析上下文  │────▶│   制定计划    │────▶│   人工审批   │
  │  (Issue /   │     │  (索引仓库,   │     │  (生成       │     │  (审核      │
  │   @提及)    │     │   构建上下文)  │     │   PRD/Plan)  │     │   PRD)     │
  └─────────────┘     └──────────────┘     └──────────────┘     └──────┬──────┘
                                                                       │
  ┌─────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────▼──────┐
  │   发布 PR   │◀────│   验证结果    │◀────│   流式观测    │◀────│  实现代码   │
  │  (Draft PR  │     │  (Build/Test/│     │  (实时看板    │     │  (OpenCode  │
  │   + 证据)   │     │   Review)    │     │   事件)      │     │   沙箱)     │
  └─────────────┘     └──────────────┘     └──────────────┘     └─────────────┘
```

1. **触发** — GitHub webhook、`@agent` 评论、标签或手动导入创建任务
2. **工作区** — 创建或复用持久 task sandbox 和 issue 分支
3. **分析** — 仓库索引、导航图、approved memory 和 ContextPack 找到最相关文件
4. **规划** — 一次 planning pass 生成 PRD/Plan 文档，用于审批和后续实现
5. **审批** — 需要人工审批时 LangGraph 中断运行，审批后在同一个 task thread 恢复
6. **实现** — OpenCode 使用生成的 prompt file 和模型配置，在同一个沙箱仓库内编辑
7. **流式** — executor 输出实时变成看板事件：进度、文件活动、命令和错误
8. **验证** — 运行 build、lint、test、typecheck、截图 hook、policy check 和 Review subagent
9. **发布** — 推送分支并创建 draft PR，附带证据、风险说明和本地验证命令

---

## 🏛️ 架构图

```mermaid
flowchart TD
  GH["GitHub Issue / Comment / Label"] --> TP["Repository Trigger Policy"]
  TP --> API["Fastify Webhook API"]
  API --> LG["LangGraph Workflow Runtime"]
  LG --> CTX["Repository Intelligence + ContextPack"]
  LG --> PRD["PRD / Planning Agent"]
  LG --> HITL["Human Approval Interrupts"]
  LG --> EXEC["OpenCode Executor Node"]
  LG --> QA["Quality Gates"]
  LG --> REV["Review Agent"]
  LG --> PR["Draft / Update PR"]
  PRD --> SDK["AI SDK Provider Registry"]
  CTX --> SDK
  REV --> SDK
  EXEC --> OC["OpenCode CLI"]
  OC --> SB["Persistent Task Sandbox"]
  SB --> DIFF["Git Diff"]
  DIFF --> QA
  LG --> EVENTS["Task Events + Artifacts"]
  EVENTS --> UI["Run Console"]
```

---

## 📁 Monorepo 结构

```text
apps/
  api/       Fastify API、GitHub webhook、settings routes、task routes
  web/       Next.js Run Console、Settings Console、Memory Inbox
  worker/    队列 worker 与仓库任务执行
packages/
  codebase-intelligence/  索引、混合搜索、ContextPack、repo graph
  config/                 YAML 配置加载与校验
  github/                 GitHub Issue、branch、comment、PR 集成
  memory/                 approved memory 与 memory proposal 存储
  model-runtime/          AI SDK 模型注册表与结构化 agent runner
  observability/          task traces 与可回放事件整理
  orchestrator/           任务状态机与 workflow 决策
  persistence/            文件/Postgres task 持久化
  sandbox/                Docker/worktree 沙箱抽象
  skills/                 平台 skill loader 与内置 skills
  tool-gateway/           可审计的 read/search/shell 工具边界
  verification/           测试、截图与本地验证辅助能力
  workflow-graph/         LangGraph task graph、checkpoint 与 callbacks
  workflows/              Issue-to-PR workflow 编排
```

---

## ⚡ 快速开始

### 前置条件

- Node.js ≥ 20
- [pnpm](https://pnpm.io/) ≥ 10
- Docker（用于本地沙箱）
- [OpenCode CLI](https://github.com/opencode-ai/opencode) 在 `PATH` 中

### 安装

```bash
# 克隆仓库
git clone https://github.com/JASON-QWeb/CodeZero.git
cd CodeZero

# 安装依赖
pnpm install

# 配置环境变量
cp .env.example .env
```

### 配置

编辑 `.env`，填入 provider 和 GitHub 凭证：

```bash
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o
GITHUB_TOKEN=ghp_...
GITHUB_WEBHOOK_SECRET=your-webhook-secret
AGENT_TRIGGER_MENTION=@codezero
```

> 💡 **提示：** 之后也可以在 **Settings Console** UI 中切换活跃 provider 并保存 API key。

### 启动

```bash
# 启动基础设施
docker compose -f infra/docker/docker-compose.yml up -d

# 启动服务（分别在不同终端，或用 `pnpm dev` 一键全部启动）
pnpm dev:api      # API 服务
pnpm dev:worker   # 任务 Worker
pnpm dev:web      # Web 控制台
```

打开 **Web 控制台**：[`http://localhost:3000`](http://localhost:3000) 🎉

---

## 🔧 OpenCode Executor

CodeZero 的实现路径是 **CLI-first**。默认沙箱 executor 会带着生成好的 prompt file 运行 OpenCode：

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

<details>
<summary><strong>供应商配置详情</strong></summary>

- 把 OpenCode 安装到 `PATH`，或在 `.env` 里设置 `OPENCODE_BIN` 指向本地二进制
- 对 **OpenAI-compatible 网关**，CodeZero 会写入临时 `OPENCODE_CONFIG`，映射 provider/model 且不暴露 API key
- **AI SDK 原生 provider**（Anthropic、Gemini、xAI、Mistral、Groq）默认走 OpenCode 的 native provider 路径
- 高级 executor 覆盖可配置在 `providers.<id>.coding_executor`

</details>

---

## 🧠 项目知识图

CodeZero 内置了轻量级仓库智能理解流程。如需更完整的项目知识图，安装官方 [Understand-Anything](https://github.com/Lum1104/Understand-Anything) Codex skill：

```bash
curl -fsSL https://raw.githubusercontent.com/Lum1104/Understand-Anything/main/install.sh | bash -s codex
```

Run Console 会运行官方 `$understand` 多 Agent pipeline 并在页面内渲染 dashboard。产物保持为上游定义的 `.understand-anything/knowledge-graph.json`。

---

## 🧪 验证命令

```bash
pnpm check          # Lint + Typecheck + 带 Coverage 的测试 + Build
pnpm eval:golden    # 使用 golden issues 评估候选产物
```

评估报告写入 `artifacts/eval-report.md`。

---

## ⚙️ 配置

运行配置位于 `config/` 目录：

| 文件 | 用途 |
|:---|:---|
| `codezero.yaml` | 模型 provider、agent 角色、仓库、沙箱、policy 和 tool gateway 默认值 |
| `codezero.example.yaml` | 新安装可参考的干净模板 |

本地运行时也可通过 **Settings Console** UI 编辑和校验这些配置。

---

## 📝 操作说明

- Agent 生成的 PRD、计划、review 说明和 PR 正文会跟随 Issue/PR 评论的语言
- 前端截图保存为 task artifact（不会提交到目标仓库分支）
- PR 创建后，人在同一个 PR conversation 中继续评论，Agent 会更新同一分支、重新验证并刷新原 PR

---

## 📄 开源协议

CodeZero 基于 [MIT License](LICENSE) 开源。

---