# Agent 架构与运行时

## 1. 主流架构取舍

截至 2026 年，生产级 Agent 系统的主流方向不是“一个大 prompt 跑到底”，而是：

- 使用可持久化 workflow 管理长任务。
- 使用明确的状态机支持暂停、重试和人工审核。
- Agent runtime 支持 tools、handoff、guardrails、tracing。
- 每个任务在隔离沙箱中运行。
- 上下文通过检索、摘要、分层压缩进入模型。
- 记忆分为 session state、project memory、episodic run memory 和 procedural playbook，不能只靠聊天记录。
- 大仓库使用 agentic search 和可演进项目地图，避免全仓库阅读。
- 由 subagent 执行独立探索、验证和审核。

本项目建议采用：

- 编排层：Temporal 或 LangGraph 风格的 durable workflow。
- Agent runtime：兼容 OpenAI Agents SDK 思想，但接口抽象为 OpenAI-compatible provider。
- 状态记录：事件溯源 + 数据库快照。
- 沙箱执行：Docker 优先，本机 worktree 可作为开发模式。
- Web 看板：订阅事件流，不直接耦合 Agent 过程。

## 2. 推荐 MVP 技术栈

### 2.1 单仓库 TypeScript 方案

```text
apps/
  web/                 # Next.js 单用户看板
  api/                 # Fastify API + webhook
  worker/              # Durable workflow worker
packages/
  agent-runtime/       # Agent 抽象、模型 provider、tool calling
  orchestrator/        # 状态机、任务编排、门禁
  sandbox/             # Docker / worktree 沙箱
  skills/              # 平台统一 skill loader
  project-context/     # 项目业务 skill 与上下文压缩
  codebase-intelligence/ # 索引、混合检索、ContextPack、项目地图
  verification/        # 测试、截图、日志解析
  github/              # Issue / PR / webhook
  shared/              # 类型定义
```

### 2.2 为什么推荐 TypeScript

- Web 看板、API、worker、GitHub 集成可以共享类型。
- 前端截图和 Playwright 生态成熟。
- 大多数现代 Web 项目本身就是 Node/TypeScript 栈。
- OpenAI-compatible HTTP client 容易统一抽象。

## 3. 工作流引擎

### 3.1 推荐优先级

第一选择：Temporal。

原因：

- 长任务可靠。
- 支持重试、超时、暂停、恢复。
- 适合 Issue 到 PR 这种跨分钟或跨小时流程。
- 便于把 Agent 的随机行为包进 activity，workflow 本身保持可恢复。

第二选择：LangGraph。

原因：

- Agent 图编排和 human-in-the-loop 表达自然。
- 适合快速验证多 Agent 流程。
- 如果后续想把 PRD、实现、审核做成图状态，迁移成本低。

MVP 可以先抽象 `WorkflowEngine` 接口，内部先用 BullMQ 或轻量 worker 跑起来，接口按 Temporal 设计，后续替换。

## 4. Agent Runtime 抽象

### 4.1 Provider 配置

```ts
type ModelProviderConfig = {
  id: string;
  baseUrl: string;
  apiKeyRef: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  supportsTools: boolean;
  supportsStructuredOutput: boolean;
};
```

### 4.2 Agent 定义

```ts
type AgentDefinition = {
  id: string;
  role:
    | "prd"
    | "search-planner"
    | "explorer"
    | "context-curator"
    | "main-implementation"
    | "frontend-qa"
    | "backend-test"
    | "review"
    | "pr-writer";
  providerId: string;
  systemPromptRef: string;
  skillRefs: string[];
  tools: string[];
  outputSchemaRef?: string;
  guardrails: string[];
};
```

### 4.3 Runtime 能力

Runtime 必须支持：

- OpenAI-compatible chat/completions 或 responses-like 请求。
- 国产 API provider profile，例如 DeepSeek / Qwen。
- tool call 分发。
- MCP-style tool registry 和 tool permission check。
- structured output 校验。
- token 预算管理。
- 上下文裁剪。
- session memory 和 history compaction。
- memory retrieval 注入，并标注来源和置信度。
- trace event 上报。
- cost / latency metrics 上报。
- handoff 给 subagent。
- guardrail 阻断。

## 5. Memory Contract

Agent runtime 不直接“相信”长期记忆。它只负责按编排层给出的 memory contract 注入上下文，并把运行结果交给 Memory Service 生成候选更新。

### 5.1 记忆类型

- `workflow_state`：任务状态、事件、artifact、审批记录，是事实来源。
- `session_memory`：当前 run 或修复循环中的短期上下文。
- `semantic_project_memory`：项目地图、业务术语、模块关系、测试指南。
- `episodic_memory`：历史 Issue/PR 的执行摘要、失败和人工反馈。
- `procedural_memory`：可复用的项目流程、验证 playbook、skill 更新建议。

### 5.2 Runtime 输入

```ts
type MemoryContextItem = {
  id: string;
  kind: "semantic" | "episodic" | "procedural" | "policy";
  summary: string;
  sourceRef: string;
  confidence: number;
  reviewedByHuman: boolean;
  createdAt: string;
};
```

所有 memory item 必须带来源，且在 prompt 中明确说明：memory 是线索，不是事实；当前 base branch、PRD、测试结果和人工审批优先级更高。

### 5.3 Runtime 输出

Agent run 结束后输出：

- run summary。
- tools used。
- files changed。
- commands run。
- failed attempts。
- human feedback。
- memory update candidates。

Memory update candidates 默认只是 artifact，不能静默写入项目长期记忆。

## 6. Tool Gateway Contract

Runtime 不应让普通 LLM action 直接执行任意命令。兼容 fallback 和高风险工具都进入 Tool Gateway：

```ts
type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
  permission: "read" | "safe_write" | "repo_write" | "external_write" | "dangerous";
  timeoutMs: number;
  requiresApproval?: boolean;
};
```

每次 tool call 必须记录：

- tool name。
- validated input summary。
- permission decision。
- execution duration。
- redacted output summary。
- linked trace span。

高风险工具调用进入 `require_approval`，由看板或 GitHub 评论确认后继续。

### 6.1 Coding Executor 模式

CodeZero 的主产品边界是服务编排，不是重新实现一个完整 coding CLI。实现阶段默认走内部 coding executor：

```text
CodeZero workflow
  -> prepare sandbox + prompt + model env
  -> run configured coding executor command
  -> read git diff
  -> run quality gates + review
  -> create/update PR
```

默认 executor 由 `sandbox.implementation_executor` 配置，当前命令通过 `npx -y opencode-ai@latest` 使用 OpenCode，并用 prompt 文件附件传入 CodeZero 请求，避免长上下文被 shell 参数长度限制截断。CodeZero 会把用户在 `agents.yaml` 中配置的 provider API key、base URL、model 映射到 executor 环境变量，例如 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL`、`LLM_API_KEY`、`LLM_BASE_URL`、`LLM_MODEL`、`CODEZERO_OPENCODE_MODEL`。

对 OpenAI-compatible 自定义网关，CodeZero 会在 task artifact 目录生成临时 `OPENCODE_CONFIG` 文件，注册内部 `codezero/<model>` provider。配置文件只包含 base URL、model 和 `{env:OPENAI_API_KEY}` 引用，不写入真实 API key，也不会进入被测仓库 diff。用户也可以在 `providers.<id>.coding_executor` 里把 sandbox coding executor 切换到任意 OpenCode native/custom provider，例如 OpenRouter、Anthropic、DeepSeek、Qwen 或私有网关。底层 CLI 是内部实现细节，不能出现在用户-facing PR body 或 issue comment 中。

### 6.2 JSON Action 兼容模式

为兼容 DeepSeek / Qwen 等不同 provider，Tool Gateway 必须支持 JSON action fallback。

模型输出：

```json
{
  "summary": "Apply the minimal refund status copy fix.",
  "actions": [
    {
      "tool": "repo.apply_patch",
      "input": {
        "unifiedDiff": "diff --git ..."
      }
    }
  ]
}
```

Orchestrator 负责：

- 校验 action 是否存在。
- 校验 input schema。
- 运行 policy。
- 执行 tool。
- 把 tool result 写回 task event、`tool-call` artifact 和 trace。

如果 provider 支持稳定 native tool calling，可以由 adapter 转成同一套 `ToolCallRequest`。

## 7. Subagent 审核流程

PR 前强制执行 `review` subagent。

输入：

- PRD。
- 最小修改计划。
- ContextPack。
- git diff。
- 测试输出。
- 截图产物。
- Agent 事件摘要。

输出：

```json
{
  "approved": false,
  "blocking_findings": [],
  "non_blocking_findings": [],
  "missing_tests": [],
  "scope_violations": [],
  "risk_level": "low | medium | high",
  "pr_description_notes": []
}
```

阻断条件：

- 有无关大规模重构。
- 未满足 PRD 验收标准。
- 前端缺截图或测试。
- 后端缺单元测试。
- 改动触及安全、权限、数据删除但无人工批准。
- 无法解释关键 diff。
- diff 超出 ContextPack 支持范围且无明确理由。

## 8. 事件流

所有 Agent 行为写入事件：

- `TASK_CREATED`
- `ISSUE_CONTEXT_COLLECTED`
- `PRD_DRAFTED`
- `HUMAN_REVIEW_REQUIRED`
- `SANDBOX_CREATED`
- `REPO_CLONED`
- `ISSUE_BRANCH_CREATED`
- `CODEBASE_INDEXED`
- `AGENTIC_SEARCH_FINISHED`
- `CONTEXT_PACK_CREATED`
- `CONTEXT_COMPRESSED`
- `MEMORY_RETRIEVED`
- `MEMORY_UPDATE_PROPOSED`
- `REPO_NAVIGATION_GRAPH_CREATED`
- `NAVIGATION_ROUTE_CREATED`
- `TOOL_CALL_REQUESTED`
- `TOOL_CALL_APPROVAL_REQUIRED`
- `POLICY_DECISION_RECORDED`
- `SECURITY_SCAN_FINISHED`
- `EVAL_RUN_FINISHED`
- `PLAN_CREATED`
- `FILE_CHANGED`
- `TEST_STARTED`
- `TEST_FINISHED`
- `BUILD_FINISHED`
- `LINT_FINISHED`
- `TYPECHECK_FINISHED`
- `SCREENSHOT_CAPTURED`
- `SUBAGENT_REVIEW_FINISHED`
- `PR_CREATED`
- `TASK_BLOCKED`

看板通过 SSE 或 WebSocket 订阅事件。

## 9. Guardrails

实现类 Agent 必须经过以下 guardrails：

- PRD 审核门禁。
- 高风险领域门禁。
- 文件范围门禁。
- 测试产物门禁。
- build/lint/typecheck 门禁。
- Issue 隔离门禁。
- PR 审核门禁。
- 最大 diff 门禁。
- 最大费用和最大运行时门禁。
- memory 来源和敏感信息门禁。
- 未审核 memory 不得升级为项目规则门禁。
- tool permission 门禁。
- policy-as-code 门禁。
- security scanning 门禁。
