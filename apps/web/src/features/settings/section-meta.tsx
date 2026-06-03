import {
  Bot,
  Database,
  GitBranch,
  Server,
  Waypoints,
} from "lucide-react";
import type { ConfigSectionName } from "./types";

export const sectionMeta: Record<
  ConfigSectionName,
  { title: string; icon: React.ReactNode; description: string }
> = {
  agents: {
    title: "模型供应商与代理",
    icon: <Bot size={18} aria-hidden />,
    description:
      "选择当前使用的模型供应商，保存 API Key，并把工作流步骤路由到对应模型。",
  },
  repositories: {
    title: "GitHub 仓库",
    icon: <GitBranch size={18} aria-hidden />,
    description:
      "配置仓库触发方式、Skill/Rule 路径、质量门禁、前端截图和 PR 行为。",
  },
  sandbox: {
    title: "沙箱运行时",
    icon: <Server size={18} aria-hidden />,
    description: "配置 Docker/worktree 沙箱模式、镜像、网络白名单和运行限制。",
  },
  memory: {
    title: "记忆系统",
    icon: <Database size={18} aria-hidden />,
    description: "配置记忆记录容量、单条大小和持久化裁剪策略。",
  },
  workflow_graph: {
    title: "工作流图",
    icon: <Waypoints size={18} aria-hidden />,
    description: "配置 LangGraph checkpoint 文件与恢复路径。",
  },
};
