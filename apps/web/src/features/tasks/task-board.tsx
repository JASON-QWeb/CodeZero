"use client";

import { useMemo } from "react";
import { Activity, CheckCircle2, GitPullRequestDraft, Search, ShieldCheck } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { Task } from "@agent/shared";
import { StatusPill } from "../../components/status-pill";

type TasksResponse = {
  tasks: Task[];
};

const mockTasks: Task[] = [
  {
    id: "task-demo-128",
    issue: {
      provider: "github",
      owner: "demo",
      repo: "commerce",
      number: 128,
      url: "https://github.com/demo/commerce/issues/128",
      title: "Fix refund status copy on order detail",
      body: "",
      labels: ["frontend"],
      comments: [],
      baseBranch: "main"
    },
    status: "SUBAGENT_REVIEWING",
    branchName: "agent/issue-128-fix-refund-status-copy",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
];

async function fetchTasks(): Promise<Task[]> {
  const baseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const response = await fetch(`${baseUrl}/tasks`, { cache: "no-store" });

  if (!response.ok) {
    throw new Error("Failed to load tasks");
  }

  const data = (await response.json()) as TasksResponse;
  return data.tasks;
}

export function TaskBoard() {
  const { data, isError } = useQuery({
    queryKey: ["tasks"],
    queryFn: fetchTasks
  });

  const tasks = data && data.length > 0 ? data : mockTasks;
  const stats = useMemo(
    () => ({
      active: tasks.filter((task) => !["DONE", "BLOCKED", "FAILED", "CANCELLED"].includes(task.status)).length,
      review: tasks.filter((task) => ["PRD_REVIEW_REQUIRED", "SUBAGENT_REVIEWING", "HUMAN_REVIEW"].includes(task.status)).length,
      blocked: tasks.filter((task) => ["BLOCKED", "FAILED"].includes(task.status)).length
    }),
    [tasks]
  );

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Agent PRD Automation</p>
          <h1>Task Board</h1>
        </div>
        <div className="health">
          <Activity size={18} aria-hidden />
          <span>{isError ? "API offline" : "Live"}</span>
        </div>
      </header>

      <section className="metrics" aria-label="Task metrics">
        <Metric icon={<Search size={18} />} label="Active" value={stats.active} />
        <Metric icon={<ShieldCheck size={18} />} label="Review" value={stats.review} />
        <Metric icon={<CheckCircle2 size={18} />} label="Blocked" value={stats.blocked} />
      </section>

      <section className="taskGrid" aria-label="Tasks">
        {tasks.map((task) => (
          <article className="taskRow" key={task.id}>
            <div className="issueCell">
              <a href={task.issue.url} target="_blank" rel="noreferrer">
                #{task.issue.number} {task.issue.title}
              </a>
              <span>
                {task.issue.owner}/{task.issue.repo} · base {task.issue.baseBranch}
              </span>
            </div>
            <StatusPill status={task.status} />
            <div className="branchCell">
              <GitPullRequestDraft size={16} aria-hidden />
              <span>{task.branchName ?? "branch pending"}</span>
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="metric">
      <div className="metricIcon">{icon}</div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

