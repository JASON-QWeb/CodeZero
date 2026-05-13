# Prompt 与 Skill 设计

## 1. 设计原则

Prompt 和 Skill 必须版本化、可审计、可回放。

每次 Agent run 都记录：

- prompt 名称
- prompt version
- skill 名称
- skill version
- 模型
- 输入摘要
- 输出产物

Skill 分为两层：

- 平台统一 skill：由本系统维护，负责通用研发流程能力。
- 项目业务 skill：由每个仓库维护，负责业务规则、项目约束和领域知识。

## 2. Prompt 分层

### 2.1 System Prompt

定义 Agent 的职责边界、安全规则、输出格式和失败处理方式。

### 2.2 Task Prompt

由编排层根据当前状态生成，例如：

- 生成 PRD
- 实现前端任务
- 实现后端任务
- 修复测试失败
- 生成 PR 描述

### 2.3 Repository Prompt

由仓库维护者配置，描述：

- 技术栈
- 代码风格
- 测试命令
- 禁止触碰的文件
- 常用模块
- 发布约束

### 2.4 Skill Prompt

每个 skill 自带执行说明，例如：

- 如何生成 PRD
- 如何运行前端截图
- 如何写后端测试
- 如何创建 PR

## 3. Skill 列表草案

### 3.1 `brainstorm-requirements`

职责：

- 从 Issue 发散需求假设。
- 找出歧义、遗漏和冲突。
- 生成待确认问题。
- 提供 2-3 个实现方向。
- 判断哪些信息必须进入 PRD。

核心提示词骨架：

```text
你是需求 brainstorm agent。请从 Issue 中提炼用户真实目标，不要直接编码。
先列出显性需求，再列出隐含需求、边界、风险和未知项。
如果信息不足，输出必须人工确认的问题。
输出必须区分：事实、推断、建议。
```

### 3.2 `draft-prd`

职责：

- 从 Issue 生成 PRD。
- 输出复杂度评分。
- 输出需要人工确认的问题。

核心提示词骨架：

```text
你是 PRD agent。请基于 Issue、brainstorm 报告、项目业务 skill 和仓库摘要生成 PRD。
PRD 必须包含背景、目标、非目标、用户故事、验收标准、影响范围、风险、未知项。
如果需求复杂或风险高，请设置 requires_human_review=true。
不要承诺无法由测试或截图验证的验收标准。
```

### 3.3 `repo-context-reader`

职责：

- 快速扫描仓库。
- 找到相关模块、测试和入口文件。
- 生成上下文摘要。

### 3.4 `repo-context-compress`

职责：

- 在沙箱 clone 完整仓库后，基于索引和 agentic search 生成 ContextPack。
- 识别技术栈、目录结构、测试命令。
- 根据 PRD 找到候选相关文件。
- 输出精读文件列表和摘要。

### 3.5 `agentic-code-search`

职责：

- 根据 Issue、PRD、业务 skill 生成搜索假设。
- 调用 keyword、path、symbol、semantic、history search。
- 多轮判断证据是否足够。
- 输出候选文件证据链。

核心提示词骨架：

```text
你是代码库搜索 agent。你的目标不是阅读整个仓库，而是找到满足当前 PRD 所需的最小证据集合。
每轮搜索前先说明搜索假设；每轮搜索后判断证据是否足够。
如果证据不足，请改写 query 或沿符号引用继续查找。
一旦证据足够，停止搜索并输出 ContextPack 草案。
```

### 3.6 `project-map-maintainer`

职责：

- 根据已合并或待审 PR 生成项目地图更新建议。
- 维护业务术语、模块映射、测试指南和变更惯例。
- 所有更新必须进入 PR，由人审核。

### 3.7 `memory-curator`

职责：

- 从 run summary、diff、测试结果和 Review 结论中提取候选记忆。
- 区分 semantic、episodic、procedural、policy memory。
- 检查候选记忆是否过度泛化、是否缺少来源、是否包含敏感信息。
- 输出 `memory-update` 或 `project-map-update` artifact，默认交给人审核。

核心提示词骨架：

```text
你是 memory curator。请只从已完成任务的事实产物中提取可复用经验。
不要把单次偶然现象升级为项目规则。
每条 memory 必须包含来源、适用范围、置信度和过期风险。
如果包含密钥、隐私、生产数据或无法确认的推断，必须拒绝写入长期记忆。
```

### 3.8 `minimal-change-planner`

职责：

- 根据 PRD 和 ContextPack 生成最小修改计划。
- 声明预计读取和修改文件。
- 声明测试计划。
- 声明明确不做的事情。

### 3.9 `sandbox-runner`

职责：

- 创建工作区。
- 安装依赖。
- 运行命令。
- 收集日志。

### 3.10 `frontend-qa`

职责：

- 启动开发服务器。
- 使用 Chrome 截图。
- 检查控制台错误。
- 运行前端测试。

### 3.11 `backend-test`

职责：

- 运行后端测试。
- 判断失败是否和当前改动相关。
- 生成测试摘要。

### 3.12 `pr-compliance-review`

职责：

- 审核提交是否符合 PRD。
- 审核是否符合最小修改原则。
- 审核测试、截图、PR 描述是否完整。
- 给出阻断或非阻断结论。
- 检查 PR 描述是否包含本地验证指令。
- 检查 memory/project-map update proposal 是否安全且有来源。

核心提示词骨架：

```text
你是 PR review subagent。请只根据 PRD、ContextPack、最小修改计划、diff、测试结果和截图进行审核。
优先找阻断问题：需求未满足、无关改动、缺少测试、安全或数据风险。
不要要求超出 PRD 的额外功能。
输出必须包含 approved、blocking_findings、missing_tests、scope_violations、risk_level。
```

### 3.13 `pr-writer`

职责：

- 生成 PR 标题和描述。
- 附带 PRD、测试结果和截图。
- 标记重点 review 区域。
- 生成 GitHub CLI 和 plain Git 两套本地验证指令。
- 写入 base branch、base commit、agent branch、sandbox image 和质量门禁命令。

### 3.14 `risk-reviewer`

职责：

- 审查 diff。
- 找出风险、遗漏测试和潜在回归。
- 决定是否阻止创建 PR。

## 4. Prompt 产物格式

### 4.1 PRD 输出格式

```json
{
  "title": "string",
  "background": "string",
  "goals": ["string"],
  "non_goals": ["string"],
  "user_stories": ["string"],
  "acceptance_criteria": ["string"],
  "risks": ["string"],
  "unknowns": ["string"],
  "task_type": "frontend | backend | fullstack | docs | unknown",
  "complexity_score": 0,
  "requires_human_review": true
}
```

### 4.2 Agent 事件格式

```json
{
  "task_id": "string",
  "agent_role": "string",
  "event_type": "thinking | command | file_change | test | artifact | blocker",
  "message": "string",
  "metadata": {}
}
```

## 5. Skill 文件建议结构

```text
skills/
  issue-to-prd/
    SKILL.md
    examples/
  frontend-qa/
    SKILL.md
    scripts/
  backend-test/
    SKILL.md
    scripts/
  pr-writer/
    SKILL.md
```

## 6. Prompt 文件建议结构

```text
prompts/
  system/
    main-agent.md
    prd-agent.md
    review-agent.md
  task/
    draft-prd.md
    implement.md
    verify-frontend.md
    verify-backend.md
    create-pr.md
```

## 7. 强制门禁 Prompt 规则

所有实现类 Agent 必须遵守：

- 如果 PRD 未批准且 `requires_human_review=true`，不得改代码。
- 如果任务涉及密钥、支付、权限、删除数据，必须请求人工审核。
- 如果无法运行测试，必须在 PR 中明确说明。
- 如果前端改动无法截图，必须阻止创建 draft PR 或标注高风险。
- 如果 diff 超过配置阈值，必须触发 Review Agent。
- 如果 Review subagent 不通过，不得创建 PR。
- 如果实际改动超出最小修改计划，必须重新说明原因或回滚无关改动。

## 8. 项目业务 Skill 加载规则

项目业务 skill 建议存放在仓库内：

```text
.agent/
  project.md
  skills/
    business-domain/
      SKILL.md
    coding-standards/
      SKILL.md
```

加载顺序：

1. 平台统一 system prompt。
2. 平台统一 skill。
3. 项目 `.agent/project.md`。
4. 项目业务 skill。
5. Issue 和 PRD。
6. ContextPack。

如果项目业务 skill 与平台安全门禁冲突，以平台安全门禁为准。
