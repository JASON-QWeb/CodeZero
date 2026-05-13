# 高级 Agent 能力矩阵

## 1. 目标

本项目要从“能自动写 PR”升级为“可观测、可评估、可治理、可扩展的 GitHub Agent 平台”。

核心新增能力：

- Trace Replay / Run Debugger
- Golden Issue Eval Harness
- MCP Tool Gateway
- Policy-as-Code Guardrails
- Repository Onboarding Agent
- PR Local Verification Plus
- Memory Feedback Loop
- Tool Permission UI
- WebUI Config Center
- Multi-Agent File Ownership / Conflict Manager
- Cost / Latency / Model Router
- Prompt / Skill Registry
- Security Scanning Pipeline
- Repo Navigation Graph
- Domestic API Provider Profiles

## 2. 能力总览

| 能力 | 一句话说明 | 主要产物 |
| --- | --- | --- |
| Trace Replay / Run Debugger | 回放每次 Agent 的状态转移、模型调用、tool call、memory hit、guardrail 结果和文件 diff | trace spans、run timeline、portable incident artifact |
| Golden Issue Eval Harness | 用固定 Issue fixtures 回归评估 PRD、ContextPack、计划、Review 和 PR body | `evals/golden-issues`、score report、CI gate |
| MCP Tool Gateway | 用统一 schema、权限、审计和 timeout 管理工具调用 | tool registry、tool call audit、approval policy |
| Policy-as-Code Guardrails | 用配置声明风险目录、危险命令、高风险领域和审批策略 | `config/policies.yaml`、policy decision events |
| Repository Onboarding Agent | 自动扫描新仓库并生成 `.agent/*` 项目知识和默认配置 | project map、testing guide、route map、trigger suggestion |
| PR Local Verification Plus | 让 PR 可以一键本地验证或在 Codespaces/Dev Container 中验证 | `agent-verify.sh`、Codespaces URL、devcontainer suggestion |
| Memory Feedback Loop | 从已完成任务提取经验，生成可审核 memory proposal | run summary、memory update、project-map update |
| Tool Permission UI | 在看板展示和审批高风险工具调用 | pending tool approvals、permission timeline |
| WebUI Config Center | 在 WebUI 中编辑、校验、保存运行配置 | settings API、YAML editor、schema validation、repo permission summary |
| Multi-Agent Conflict Manager | 管理多个 worker 的文件所有权和 patch 合并 | ownership plan、conflict report、merge decision |
| Cost / Latency / Model Router | 根据任务复杂度、预算和质量要求选择模型 | routing policy、cost report、latency metrics |
| Prompt / Skill Registry | prompt、skill、模型配置版本化，可回放和回归 | registry、version lock、prompt diff |
| Security Scanning Pipeline | 对 Agent diff 和 artifacts 做 secret、依赖、SAST、prompt-injection 检查 | security report、blocking findings |
| Repo Navigation Graph | 给 Agent 提供仓库入口、调用链、依赖、测试、ownership 的导航图 | repo graph、code landmarks、search routes |
| Domestic API Provider Profiles | 面向 DeepSeek / Qwen 等国产 OpenAI-compatible API，支持 native tool 或 JSON action fallback | provider profiles、JSON repair、capability matrix |

## 3. 推荐实现顺序

### P0：让系统可解释

1. Trace Replay / Run Debugger。
2. Repo Navigation Graph。
3. Policy-as-Code Guardrails。
4. PR Local Verification Plus。

理由：这四项能最快提升作品集观感。面试官能看到 Agent 怎么理解仓库、为什么做出某个决策、如何控制风险，以及开发者怎么验证结果。

### P1：让系统可评估

1. Golden Issue Eval Harness。
2. Prompt / Skill Registry。
3. Cost / Latency / Model Router。

理由：Agent 项目如果没有 eval 和版本锁，很难证明质量稳定。P1 做完后，可以在 CI 中展示每次 prompt 或检索策略变更是否退化。

### P2：让系统可扩展

1. MCP Tool Gateway。
2. Repository Onboarding Agent。
3. Tool Permission UI。

理由：这三项让系统从“服务一个 repo 的 bot”变成“可以接入不同仓库、不同工具、不同权限策略的平台”。

### P3：让系统能自我改进

1. Memory Feedback Loop。
2. Multi-Agent Conflict Manager。
3. Security Scanning Pipeline。

理由：P3 展示更高阶的生产能力：经验复用、并行协作、安全治理。

## 4. Trace Replay / Run Debugger

每个 task 应生成可回放 trace：

```json
{
  "taskId": "task-acme-shop-42",
  "traceId": "trace_123",
  "spans": [
    {
      "id": "span_1",
      "parentId": null,
      "kind": "workflow_step",
      "name": "AGENTIC_SEARCHING",
      "startedAt": "2026-05-11T10:00:00.000Z",
      "endedAt": "2026-05-11T10:00:05.000Z",
      "metadata": {
        "queries": ["refund status", "order detail refund"],
        "memoryHits": ["mem_128"],
        "selectedFiles": ["src/orders/order-detail.tsx"]
      }
    }
  ]
}
```

看板展示：

- 状态机时间线。
- LLM call 和 structured output。
- tool call 输入输出摘要。
- memory hit。
- guardrail decision。
- diff 和质量门禁。
- 阻断原因和可恢复步骤。

敏感信息默认不写入 trace，必要时只保存摘要和 redaction marker。

## 5. Golden Issue Eval Harness

建议目录：

```text
evals/
  golden-issues/
    refund-status-copy/
      issue.json
      expected-prd.json
      expected-context-files.json
      seeded-repo/
      assertions.ts
```

评估维度：

- PRD 覆盖率：是否覆盖目标、非目标、验收标准、风险。
- ContextPack 命中率：是否找到目标文件和目标测试。
- 最小修改计划：是否避免无关文件。
- Review subagent：是否能发现故意植入的缺测试、越权改动、无关重构。
- PR body：是否包含本地验证指令、质量门禁、截图和风险说明。

建议输出：

```json
{
  "evalSuite": "golden-issues",
  "score": 0.87,
  "prdScore": 0.92,
  "contextPackRecall": 0.8,
  "scopePrecision": 0.9,
  "reviewBugCatchRate": 0.75,
  "regressions": []
}
```

## 6. MCP Tool Gateway

MCP Tool Gateway 负责把工具调用标准化：

- tool registry。
- JSON schema 输入校验。
- permission level。
- timeout 和 retry。
- output redaction。
- tool call trace。
- approval policy。

建议工具分级：

| 等级 | 示例 | 默认策略 |
| --- | --- | --- |
| read | list files、read file、search、read issue | 自动允许 |
| safe write | write artifact、create draft note | 自动允许并记录 |
| repo write | apply patch、commit、push branch | 需要满足 workflow guardrails |
| external write | create PR、comment issue、update label | 需要任务权限 |
| dangerous | delete files、run migration、publish package | 默认人工审批 |

MCP 的 tools/resources/prompts/roots 概念也可以映射到本项目：

- tools：GitHub、shell、browser、verification、memory、indexer。
- resources：PRD、ContextPack、artifact、repo graph、trace。
- prompts：platform skill、project skill、task prompt。
- roots：当前 task sandbox、artifact dir、只读配置目录。

## 7. Policy-as-Code Guardrails

建议新增 `config/policies.yaml`：

```yaml
policies:
  - id: block-secret-files
    description: Agent must not modify secrets or private keys.
    match_paths:
      - ".env*"
      - "**/*.pem"
      - "**/*.key"
    action: block

  - id: require-human-review-for-auth
    description: Auth and billing changes require human approval.
    match_paths:
      - "src/auth/**"
      - "src/billing/**"
    action: require_approval

  - id: block-dangerous-shell
    match_commands:
      - "rm -rf"
      - "npm publish"
      - "kubectl apply"
    action: block
```

Policy engine 输入：

- Issue/PRD。
- planned files。
- actual diff。
- tool call request。
- command request。
- memory update proposal。

输出：

- `allow`
- `allow_with_audit`
- `require_approval`
- `block`

## 8. Repository Onboarding Agent

新仓库第一次接入时，Agent 不应直接执行 Issue，而应先生成项目知识。

产物：

```text
.agent/
  project.md
  module-map.md
  business-glossary.md
  route-map.md
  ownership.md
  testing-guide.md
  change-patterns.md
  policy-suggestions.md
```

流程：

1. clone 仓库。
2. 识别技术栈、package manager、框架和 monorepo layout。
3. 建立 Repo Navigation Graph。
4. 推断 build/lint/test/typecheck 命令。
5. 找到 app routes、API routes、database migrations、test directories。
6. 生成 `.agent/*` 建议。
7. 生成 `repositories.yaml` 配置建议。
8. 人审后启用自动任务。

## 9. Multi-Agent Conflict Manager

当主 Agent 拆分多个 worker 时，需要明确文件所有权。

```json
{
  "taskId": "task-acme-shop-42",
  "ownership": [
    {
      "agentRole": "frontend-worker",
      "canWrite": ["src/orders/**", "src/components/refund/**"],
      "readOnly": ["src/billing/**"]
    },
    {
      "agentRole": "backend-test-worker",
      "canWrite": ["src/billing/**/*.test.ts"],
      "readOnly": ["src/billing/**/*.ts"]
    }
  ]
}
```

冲突策略：

- 同一文件只能有一个 writer。
- 多 worker patch 合并前运行 scope check。
- conflict manager 生成合并摘要。
- Review subagent 检查是否违反 ownership。

## 10. Model Router

模型路由可以展示成本和质量意识。

当前基础实现：

- `agents.yaml` 的每个 Agent step 都可配置 provider。
- `implementation` / `review` 等执行阶段可通过 `provider_by_complexity.low|medium|high` 按 PRD complexity score 切换 provider。
- provider 引用会在 Settings API 保存时校验，避免配置指向不存在的模型。
- WebUI Settings Console 可以编辑和校验 provider、step routing 与 complexity routing。

路由依据：

- task type。
- complexity score。
- risk level。
- required tools。
- context size。
- retry count。
- budget。

示例：

```yaml
model_routing:
  prd:
    default: fast
  search_planner:
    default: fast
  implementation:
    low_risk: balanced
    high_risk: strong
  review:
    default: strong
```

当前配置示例：

```yaml
agents:
  implementation:
    provider: qwen_fast
    provider_by_complexity:
      low: qwen_fast
      medium: qwen_fast
      high: deepseek_strong
```

记录指标：

- input/output tokens。
- cost estimate。
- latency。
- retry count。
- quality gate pass/fail。

## 11. Security Scanning Pipeline

PR 创建前增加安全门禁：

- secret scan。
- dependency audit。
- dangerous file path scan。
- dangerous command scan。
- prompt injection scan for Issue/comments/project docs。
- generated code SAST。
- license check，如果新增依赖。

任何安全门禁失败都必须阻断 PR 或请求人工批准。

## 12. 与 Repo Navigation Graph 的关系

Repo Navigation Graph 是这些能力的底座之一：

- Onboarding Agent 用它生成项目地图。
- Agentic search 用它确定检索路线。
- ContextPack 用它解释为什么选这些文件。
- Review subagent 用它判断 diff 是否越界。
- Eval harness 用它衡量目标文件命中率。
- Memory system 用它把历史经验挂到模块和符号上。

详细设计见 [REPO_NAVIGATION_GRAPH.md](REPO_NAVIGATION_GRAPH.md)。
