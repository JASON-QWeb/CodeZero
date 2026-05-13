# 待确认问题

这份清单只保留尚未最终确认的产品和实现取舍。已经确认的内容记录在 [DECISIONS.md](DECISIONS.md)。

## 1. 入口

已确认：

- 第一版优先支持 GitHub Issue。
- 产品形态是 GitHub Bot。
- 触发方式需要支持仓库级配置：`auto`、`mention`、`label`、`manual`、`disabled`。

待确认：

1. 是否需要支持 Linear/Jira？
2. GitHub App 是否第一阶段就替代 token 模式，还是先保留 `GITHUB_TOKEN` MVP？
3. `label` 模式的默认 allowlist 是否使用 `agent-ready`？

## 2. 沙箱

已确认：Docker 沙箱作为第一版默认实现，本机 git worktree 只作为开发模式。

1. Agent 是否允许访问网络安装依赖？
2. 网络白名单第一版是否只开放 GitHub、模型 API、包管理器 registry？

## 3. 人工审核

已建议：复杂度 `40+` 必须审核，`70+` 必须拆分或补充方案。

1. 是否接受 `40+` 作为第一版强制 PRD 审核阈值？
2. 人工审核是在 Web 看板里完成，还是通过 GitHub Issue 评论完成？
3. 审核通过后是否自动开始编码？

## 4. Skill 与 Prompt

1. 平台统一 skill 已确认；项目业务 skill 已确认。
2. Prompt 修改是否需要审核和版本发布？
3. 是否需要保存每次 Agent 的完整输入输出，还是只保存摘要和必要 trace？
4. memory update proposal 是否要求单独人工审批，还是随 Agent PR 一起审批？
5. Prompt / Skill Registry 第一版是否只做文件版本锁，还是接入数据库和看板编辑？

## 4.2 模型 Provider

已确认：

- 默认面向 DeepSeek / Qwen 等国产 OpenAI-compatible API。
- 当前阶段不重点处理企业私有代码出域治理、私有化模型部署和复杂脱敏策略。
- 模型可以有 agent 能力，但平台仍通过 Tool Gateway 执行真实工具。

待确认：

1. `deepseek-v4` 和 `qwen3.5` 的默认角色分工：是否 implementation/review 都使用同一模型？
2. 是否需要保留 Kimi/Moonshot provider 示例？
3. 是否需要为不同 provider 配置 JSON repair prompt？

## 4.1 Codebase Intelligence

已确认：

- 需要加入 Repo Navigation Graph，作为提升 Agent 读代码速度和准确度的核心能力。
- 每个任务应生成 `navigation-route.json`，供 ContextPack、实现计划和 Review 使用。

待确认：

1. 第一版导航图是否只支持 TypeScript/JavaScript，还是同时支持 Python/Go？
2. git history changed-with edge 是否默认开启，还是只在仓库较小时开启？
3. CODEOWNERS 缺失时，是否由 onboarding agent 自动生成 ownership 建议？

## 5. 前端验证

1. 截图页面如何确定：PRD 指定、Agent 推断，还是仓库配置？
2. 是否需要移动端截图？
3. 是否需要视觉回归 diff？

## 6. 后端验证

1. 每个仓库是否提供测试命令模板？
2. 是否要求覆盖率阈值？
3. 数据库迁移是否允许 Agent 自动生成？

## 7. PR 策略

已确认：每个 Issue 独立分支、独立 PR；PR 默认 draft；PR 创建前必须通过 build/lint/test/typecheck 和 Review subagent。
已确认：PR 描述必须包含本地验证指令。

1. Agent 是否可以自动 push 分支？
2. PR 描述中是否展示完整日志，还是只链接到看板？
3. 是否要额外生成一键验证脚本，例如 `agent-verify.sh` 或 `npx agent-prd verify`？

## 8. 看板

已确认：第一版单用户看板，不做权限系统。

1. 是否需要实时日志流？
2. 是否需要在看板中直接展示 ContextPack 和 Review subagent 证据链？
3. 是否需要在看板中展示 trace replay、tool approval 和 navigation route？

## 9. MVP 边界

建议 MVP 选择：

- GitHub Issue
- 多仓库配置，单个任务仍只操作一个仓库
- Docker 沙箱，本机 worktree 仅开发模式
- PRD 人工审核
- Agentic search + ContextPack
- 记忆架构文档和 memory proposal artifact
- Repo Navigation Graph 和 navigation route artifact
- 每个 Issue 独立分支和独立 PR
- build/lint/test/typecheck 质量门禁
- Agent 实现
- 前端截图
- 单元测试
- 自动创建 draft PR
- PR 本地验证指令
- Trace Replay / Run Debugger
- Golden Issue Eval Harness
- MCP Tool Gateway
- Policy-as-Code Guardrails
- Repository Onboarding Agent
- Security Scanning Pipeline
- 简单 Web 看板
