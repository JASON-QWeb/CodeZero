# 代码施工路线图

## 1. 当前最终目标

项目目标收束为：

> 一个企业级可用的 GitHub Agent Bot：按仓库配置触发策略，从 Issue 生成 PRD，在独立沙箱中通过 Repo Navigation Graph 快速理解代码，调用 DeepSeek / Qwen 等 OpenAI-compatible 国产 API 完成实现、验证、Review，并创建带本地验证指令的 draft PR。

这版施工路线优先保证：

- 可运行闭环。
- 可解释决策。
- 可验证 PR。
- 可插拔模型和工具。
- 可在不同仓库复用。

## 2. 明确不做或暂缓

为避免项目过宽，以下能力不作为当前施工重点：

- 企业私有代码出域治理。
- 私有化模型部署。
- 复杂脱敏策略。
- 多租户权限系统。
- 自动合并 PR。
- 完整 CI/CD 替代。

保留但不复杂化：

- secret scan、dangerous path scan、policy guardrails 仍保留，因为它们是 Agent 写代码质量和安全门禁的一部分。
- 模型 provider 抽象仍保留，因为 DeepSeek、Qwen、Kimi、OpenAI-compatible 私有网关都可以通过同一接口接入。

## 3. 模型与国产 API 策略

默认按 OpenAI-compatible provider 设计。

首选目标模型：

- `deepseek-v4`
- `qwen3.5`

模型能力假设：

- 支持较强代码理解和生成。
- 支持长上下文或较长上下文。
- 支持结构化 JSON 输出，或可以通过 prompt + parser repair 稳定输出 JSON。
- 可以配合本项目 Tool Gateway 完成 agentic workflow。

重要原则：

- 模型不直接执行工具。
- 模型只输出结构化 action 或 JSON artifact。
- Tool Gateway 负责真正执行 shell、git、GitHub、browser、verification、memory 等工具。
- 如果 provider 原生 tool calling 稳定，可以接入；如果不稳定，回退到 JSON action 模式。

建议 provider 能力配置：

```ts
type ProviderCapabilities = {
  supportsNativeToolCalling: boolean;
  supportsJsonMode: boolean;
  supportsStructuredOutput: boolean;
  maxContextTokens: number;
  preferredActionMode: "native_tool" | "json_action";
};
```

## 4. 施工总顺序

### Phase 1：仓库级触发策略

目标：同一个 Bot 可以针对不同仓库配置触发方式。

实现：

- 扩展 `RepositoryConfig.trigger`。
- webhook 根据仓库配置决定是否创建 task。
- 支持 `auto`、`mention`、`label`、`manual`、`disabled`。
- 增加触发策略测试。

验收：

- `mention` 模式下，只有评论包含仓库配置 mention 才触发。
- `label` 模式下，只有 allowlist 标签触发。
- `disabled` 模式下，不创建 task。

### Phase 2：Repo Navigation Graph MVP

目标：提升 Agent 在大仓库中的读代码速度和准确度。

当前状态：基础 MVP 已落地，包含文件图、TS/JS import/export 关系、route detector、source-to-test heuristic、business concept edge、git history changed-with edge、`repo-navigation-graph.json` 和 `navigation-route.json` artifact。

实现 MVP：

- 文件路径图。
- TypeScript/JavaScript import/export 图。
- 简单 symbol 节点。
- route detector。
- source-to-test heuristic。
- `.agent/*` 业务术语链接。
- git history changed-with edge。
- 生成 `repo-navigation-graph.json` 和 `navigation-route.json`。

验收：

- 给定 Issue 文本，能产出 entrypoints、mustRead、tests、doNotModify、reasoning。
- ContextPack 文件选择使用 navigation route。
- Review subagent 能读取 navigation route 做 scope check。

### Phase 3：PR Local Verification Writer

目标：让每个 Agent PR 都带可复制运行的本地验证指令。

实现：

- 已完成基础实现：记录 base branch、base SHA、agent branch、sandbox mode/image。
- 已完成基础实现：记录 quality gate commands 和执行结果。
- 已完成基础实现：生成 GitHub CLI 和 plain Git 两套 checkout/验证指令。
- 已完成基础实现：生成 `pr-local-verification.json` artifact。
- 已完成基础实现：PR body 写入质量门禁和截图 artifact。
- 后续增强：可选生成 `agent-verify.sh`，并让 Review subagent 对 PR body 做结构化断言。

验收：

- 已完成基础实现：PR 描述包含完整 Local Verification。
- 后续增强：Review subagent 缺少验证指令时阻断。

### Phase 4：Tool Gateway

目标：把工具调用从模型输出中剥离，统一审计、校验和执行。

实现：

- 已完成基础实现：`@agent/tool-gateway` 包。
- 已完成基础实现：`ToolDefinition`、`ToolRegistry`、`ToolCallRequest`、`ToolCallResult`。
- 已完成基础实现：permission level：`read`、`safe_write`、`repo_write`、`external_write`、`dangerous`。
- 已完成基础实现：policy evaluator 支持 tool、permission、path、command 匹配，输出 `block` 或 `require_approval`。
- 已完成基础实现：内置 `repo.read_file`、`repo.search`、`repo.apply_patch`、`shell.run`。
- 已完成基础实现：JSON action parser/runner，支持国产 OpenAI-compatible provider 走 JSON action fallback。
- 已完成基础实现：workflow implementation 阶段接入 Tool Gateway，旧 `unifiedDiff` 会自动包装成 `repo.apply_patch` action。
- 已完成基础实现：tool call event、policy decision event 和 `tool-call` artifact。
- 后续增强：tool input schema 校验、审批恢复和看板 Tool Permission UI。

验收：

- 已完成基础实现：危险工具调用被 policy 阻断或要求审批。
- 已完成基础实现：Implementation Agent 可输出 JSON action，Orchestrator 通过 Tool Gateway 执行 tool，并把 tool call 写入 event/artifact。
- 后续增强：补充原生 tool calling adapter、审批恢复和更严格的 tool input schema。

### Phase 5：Policy-as-Code 和基础安全门禁

目标：让 Agent 行为有明确边界。

实现：

- 已完成基础实现：读取 `config/policies.yaml` 和 `config/tools.yaml`。
- 已完成基础实现：path policy。
- 已完成基础实现：command policy。
- memory proposal policy。
- diff scope policy。
- secret scan。

验收：

- 已完成基础实现：修改 `.env`、私钥等危险路径时阻断或要求审批。
- 已完成基础实现：执行危险命令时阻断。
- 触碰 auth/billing/migration 时进入人工审批。

### Phase 6：Trace Replay / Run Debugger

目标：让每次 Agent 决策可解释。

实现：

- 已完成基础实现：`@agent/observability` 包和 trace span 数据模型。
- 已完成基础实现：`GET /tasks/:id/trace`，把 task events + artifacts 转成可回放 timeline。
- 已完成基础实现：workflow step span。
- model call span。
- 已完成基础实现：tool call span。
- 已完成基础实现：navigation route span。
- memory hit span。
- 已完成基础实现：policy decision span。
- 已完成基础实现：Run Console 看板展示 task 详情、trace summary 和 timeline。

验收：

- 已完成基础实现：任一 task 可通过 API 和看板看到从 Issue 到 PR 的 timeline。
- 已完成基础实现：失败 task 可定位是 PRD、search、tool、policy、quality gate 还是 review 阻断。

### Phase 7：Golden Issue Eval Harness

目标：证明 Agent 质量稳定。

实现：

- 已完成基础实现：`@agent/evals` 评分器、`pnpm eval:golden` CLI、CI report artifact 和 3 个 golden issue fixtures。
- 后续增强：PRD assertion。
- 已完成基础实现：navigation route assertion。
- 已完成基础实现：ContextPack file/test/memory assertion。
- minimal plan assertion。
- Review assertion。
- 已完成基础实现：PR body section assertion。
- 已完成基础实现：Trace span kind assertion。

验收：

- 已完成基础实现：测试中可运行 eval，并输出可消费的 score report。
- 已完成基础实现：独立 CLI/CI score report artifact。
- 已完成基础实现：memory/context/navigation/PR body regression 能被 fixture 发现。

### Phase 8：Memory Feedback Loop

目标：让系统从历史 Issue/PR 学习，但不静默污染规则。

实现：

- 已完成基础实现：`@agent/memory` 包和本地 `FileMemoryStore`。
- 已完成基础实现：run summary 风格的 episodic/procedural memory proposal。
- 已完成基础实现：任务创建 PR 后生成 `memory-proposal.json` artifact。
- project-map update artifact。
- 已完成基础实现：Memory API 和 Run Console Memory Inbox 可列出 proposed memory，并执行 approve/reject。
- 后续增强：Review subagent 审核 memory proposal。
- 已完成基础实现：Memory Store 只检索 `approved` records。
- 已完成基础实现：ContextPack 检索 approved memory，并生成 `memory-context.json` artifact。

验收：

- 已完成基础实现：已完成 task 能生成 memory proposal。
- 已完成基础实现：未审核 memory 不进入长期检索结果。
- 下次相似任务能命中已审核 memory。

### Phase 9：Repository Onboarding Agent

目标：让新仓库快速接入。

实现：

- 已完成基础实现：首次扫描仓库。
- 已完成基础实现：构建 Repo Navigation Graph。
- 已完成基础实现：生成 `.agent/project.md`、`module-map.md`、`route-map.md`、`testing-guide.md`。
- 已完成基础实现：生成 `repositories.yaml` 建议。
- 已完成基础实现：生成 policy 建议。
- 已完成基础实现：提供 `pnpm onboard:repo` CLI。

验收：

- 已完成基础实现：对新仓库运行 onboarding 后，能得到可审查的 `.agent/*` 建议。
- 人审后即可进入 Issue workflow。

## 5. 推荐最小代码落地路径

为了尽快进入可演示状态，建议先做 6 个 PR：

1. `RepositoryConfig.trigger` + webhook 触发策略。已完成基础实现。
2. `RepoGraphBuilder` + `NavigationRouteBuilder`。已完成基础实现。
3. ContextPack 接入 navigation route。已完成基础实现。
4. PR body Local Verification 生成器。已完成基础实现。
5. Tool Gateway + JSON action runner。已完成基础实现，并已接入 implementation workflow。
6. Trace span 数据模型和 task trace API。已完成基础实现。

做完这 6 个 PR，项目就从“能跑的 Agent workflow”升级成“有仓库理解、有工具边界、有可解释性的 Agent 平台”。

## 6. 目录建议

```text
packages/
  codebase-intelligence/
    src/navigation-graph/
      repo-graph-builder.ts
      navigation-route.ts
      route-detectors.ts
      test-linker.ts
      history-linker.ts
  tool-gateway/
    src/index.ts
    src/json-action-parser.ts
  policy-engine/
    src/policy-loader.ts
    src/policy-evaluator.ts
  observability/
    src/trace-recorder.ts
    src/run-replay.ts
  evals/
    src/golden-issue-runner.ts
```

## 7. 面试讲法

这套施工路线可以这样讲：

1. 我没有让模型直接读完整仓库，而是先构建 Repo Navigation Graph。
2. Agent 先拿 navigation route，再拿小型 ContextPack，降低无关阅读和误改。
3. 模型不直接执行工具，所有 action 通过 Tool Gateway、Policy 和 Trace。
4. PR 不只是生成代码，还生成开发者可本地验证的说明。
5. 系统通过 golden issue eval 和 trace replay 持续提高可靠性。
6. 国产 API 只需要符合 OpenAI-compatible 或 JSON action 输出，就能接入完整 workflow。
