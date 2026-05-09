# 待确认问题

这份清单只保留尚未最终确认的产品和实现取舍。已经确认的内容记录在 [DECISIONS.md](DECISIONS.md)。

## 1. 入口

1. 第一版是否只支持 GitHub Issue？
2. Issue 触发方式是 webhook、手动选择，还是两者都要？
3. 是否需要支持 Linear/Jira？

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

1. Agent 是否可以自动 push 分支？
2. PR 描述中是否展示完整日志，还是只链接到看板？

## 8. 看板

已确认：第一版单用户看板，不做权限系统。

1. 是否需要实时日志流？
2. 是否需要在看板中直接展示 ContextPack 和 Review subagent 证据链？

## 9. MVP 边界

建议 MVP 选择：

- GitHub Issue
- 单仓库
- Docker 沙箱，本机 worktree 仅开发模式
- PRD 人工审核
- Agentic search + ContextPack
- 每个 Issue 独立分支和独立 PR
- build/lint/test/typecheck 质量门禁
- Agent 实现
- 前端截图
- 单元测试
- 自动创建 draft PR
- 简单 Web 看板
