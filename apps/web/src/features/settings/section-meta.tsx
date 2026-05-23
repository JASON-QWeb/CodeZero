import { Bot, GitBranch, Server, Shield, Wrench } from "lucide-react";
import type { ConfigSectionName } from "./types";

export const sectionMeta: Record<ConfigSectionName, { title: string; icon: React.ReactNode; description: string }> = {
  agents: {
    title: "Model Providers & Agents",
    icon: <Bot size={18} aria-hidden />,
    description: "Configure DeepSeek, Qwen, OpenAI-compatible providers and choose which provider each workflow step uses."
  },
  repositories: {
    title: "GitHub Repositories",
    icon: <GitBranch size={18} aria-hidden />,
    description: "Configure repository trigger mode, quality gates, frontend screenshots and PR behavior."
  },
  tools: {
    title: "Tool Permissions",
    icon: <Wrench size={18} aria-hidden />,
    description: "Configure tool permissions and timeout boundaries used by Tool Gateway."
  },
  policies: {
    title: "Policy Guardrails",
    icon: <Shield size={18} aria-hidden />,
    description: "Configure path, command, tool and permission policies for block or approval decisions."
  },
  sandbox: {
    title: "Sandbox Runtime",
    icon: <Server size={18} aria-hidden />,
    description: "Configure Docker/worktree sandbox mode, image, network allowlist and runtime limits."
  }
};
