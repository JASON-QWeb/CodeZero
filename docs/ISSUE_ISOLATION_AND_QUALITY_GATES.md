# Issue 隔离与 PR 质量门禁

## 1. 核心原则

每个 Issue 必须独立执行、独立分支、独立 PR。

系统不能让前一个 Issue 的未合并改动影响后一个 Issue，否则会造成：

- diff 混杂。
- Review 困难。
- 回滚困难。
- 任务归因不清。
- Agent 误以为前一个任务的改动已经是主线事实。

## 2. Issue 隔离规则

### 2.1 每个 Issue 独立沙箱

每个任务创建独立沙箱：

```text
/sandboxes/{task_id}/repo
/sandboxes/{task_id}/artifacts
/sandboxes/{task_id}/logs
```

禁止多个 Issue 共享同一个可写工作区。

### 2.2 每个 Issue 从 base branch 开始

默认流程：

1. clone 远端仓库。
2. checkout 最新 base branch，例如 `main`。
3. 创建独立任务分支。
4. 执行当前 Issue。
5. 创建当前 Issue 的 PR。

后一个 Issue 不基于前一个 Issue 的任务分支，除非人明确指定依赖关系。

### 2.3 分支命名

建议：

```text
agent/issue-{issue_number}-{short-slug}
```

示例：

```text
agent/issue-128-fix-refund-status
```

### 2.4 PR 粒度

一个 Issue 对应一个 PR。

如果 PRD 判断 Issue 太大，应进入人工审核或拆分建议，不应自动生成一个巨大 PR。

### 2.5 禁止跨 Issue 污染

实现 Agent 必须遵守：

- 不读取其他未合并任务分支作为事实来源。
- 不把其他任务沙箱的文件复制进当前任务。
- 不复用其他任务的未合并 diff。
- 不在当前 PR 中包含其他 Issue 的改动。

允许读取的跨任务信息只有：

- 已合并到 base branch 的代码。
- 已审核合并的项目地图。
- 历史 PR 摘要索引。
- 人明确指定的依赖 PR。

## 3. 依赖 Issue 处理

如果 Issue B 依赖 Issue A：

- 默认仍从 base branch 创建 Issue B 的任务。
- 如果必须基于 Issue A 的 PR，必须由人明确批准。
- 看板上标记依赖关系。
- PR 描述中说明依赖 PR。
- B 的 PR 默认保持 draft，直到 A 合并。

## 4. PR 前质量门禁

PR 创建前必须通过质量门禁。

### 4.1 必须通过

- build 成功。
- lint 成功。
- 单元测试成功。
- 类型检查成功，如果项目存在类型检查命令。
- 前端任务必须有 Chrome 截图。
- 后端任务必须有相关单元测试。
- Review subagent 审核通过。

### 4.2 命令来源优先级

质量门禁命令按以下顺序确定：

1. 仓库 `.agent/testing-guide.md` 或 `.agent/project.md`。
2. 仓库配置 `repositories.yaml`。
3. package scripts，例如 `build`、`lint`、`test`、`typecheck`。
4. Agent 根据技术栈推断，并要求 Review subagent 检查合理性。

### 4.3 推荐命令模型

```json
{
  "build": "npm run build",
  "lint": "npm run lint",
  "typecheck": "npm run typecheck",
  "unit_test": "npm test",
  "frontend_screenshot": "npm run qa:screenshot"
}
```

如果某个命令不存在，Agent 不能静默跳过，必须：

- 记录原因。
- 尝试找到项目等价命令。
- 如果仍无法确定，进入人工审核或在 PR 中标注阻断风险。

## 5. 失败处理

### 5.1 build / lint / test 失败

Agent 可以进入修复循环，但必须有上限：

- 默认最多 3 轮自动修复。
- 每轮只允许修改与失败直接相关的文件。
- 每轮必须记录失败摘要和修复原因。

超过上限后进入 `BLOCKED_QUALITY_GATE_FAILED`。

### 5.2 前端截图失败

前端任务如果无法截图：

- 检查 dev server 是否启动。
- 检查页面 URL 是否配置。
- 检查控制台错误。
- 最多重试 2 次。

仍失败则不创建 PR，除非人工明确允许。

## 6. PR 描述必须包含

- Issue 链接。
- base branch。
- task branch。
- PRD 链接。
- build 结果。
- lint 结果。
- test 结果。
- typecheck 结果。
- 前端截图链接，如果适用。
- Review subagent 结论。
- 是否依赖其他 PR。
- GitHub CLI 本地验证指令。
- plain Git 本地验证指令。
- install、build、lint、typecheck、test 命令。
- sandbox image 和 Agent 已运行命令摘要。

## 7. Review Subagent 额外检查

Review subagent 必须额外检查：

- PR 是否只包含当前 Issue 的改动。
- 分支是否从正确 base branch 创建。
- diff 是否包含其他 Issue 的遗留改动。
- build/lint/test/typecheck 是否通过。
- 如果有失败，是否被明确标记为阻断。
- PR 描述是否包含可执行的本地验证步骤。

未通过则不得创建 PR。
