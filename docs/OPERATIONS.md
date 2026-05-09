# 本地运行与真实接入

## 1. 必需配置

复制配置文件：

```bash
cp config/agents.example.yaml config/agents.yaml
cp config/repositories.example.yaml config/repositories.yaml
cp config/sandbox.example.yaml config/sandbox.yaml
cp .env.example .env
```

设置环境变量：

```bash
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=...
OPENAI_MODEL=...
GITHUB_TOKEN=...
GITHUB_WEBHOOK_SECRET=...
AGENT_TRIGGER_MENTION=@agent-prd
REDIS_URL=redis://localhost:6379
```

`GITHUB_TOKEN` 需要权限：

- 读取 Issue。
- push 分支。
- 创建 draft PR。

## 2. 启动依赖

```bash
docker compose -f infra/docker/docker-compose.yml up -d
```

默认使用文件存储 `data/tasks.json`。如需 Postgres：

```bash
STORAGE_DRIVER=postgres
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/agent_prd
```

## 3. 启动服务

```bash
pnpm dev:api
pnpm dev:worker
pnpm dev:web
```

看板：

```text
http://localhost:3000
```

API：

```text
http://localhost:4000
```

## 4. 手动导入 Issue

```bash
curl -X POST http://localhost:4000/tasks/import-issue \
  -H 'content-type: application/json' \
  -d '{
    "owner": "your-org",
    "repo": "your-repo",
    "number": 123,
    "url": "https://github.com/your-org/your-repo/issues/123",
    "title": "Example issue",
    "body": "Issue body",
    "labels": ["frontend"],
    "baseBranch": "main"
  }'
```

## 5. GitHub Webhook

Webhook URL：

```text
POST /webhooks/github
```

支持事件：

- `issues.opened`
- `issues.labeled`
- `issues.reopened`
- `issue_comment.created`

触发方式：

1. 自动模式：新建 / 重新打开 / 打标签 Issue 会自动创建任务。
2. @ 机器人模式：在 Issue 评论中包含 `.env` 里的 `AGENT_TRIGGER_MENTION`，默认 `@agent-prd`，会创建或重新入队该 Issue 任务。

GitHub Webhook 配置时，`Events` 至少选择：

- Issues
- Issue comments

如果设置了 `GITHUB_WEBHOOK_SECRET`，服务会使用 `x-hub-signature-256` 做真实验签。

## 6. 执行门禁

worker 会按顺序执行：

1. PRD Agent。
2. PRD 人审门禁。
3. Docker 沙箱 clone。
4. Issue 独立分支。
5. codebase index。
6. agentic search。
7. ContextPack。
8. minimal change plan。
9. implementation diff。
10. build/lint/typecheck/unit test。
11. 前端 Chrome 截图，如果配置了 URL。
12. Review subagent。
13. commit/push/draft PR。

没有 OpenAI 或 GitHub 凭证时，任务会进入 `FAILED` 或 `BLOCKED` 并记录明确事件；不会假装成功。

