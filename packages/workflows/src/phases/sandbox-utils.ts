import path from "node:path";
import { mkdir } from "node:fs/promises";
import type { AppConfig } from "@agent/config";
import type { Sandbox } from "@agent/sandbox";
import type { Task } from "@agent/shared";

export function taskSandbox(
  task: Pick<Task, "id" | "sandbox">,
): Sandbox | undefined {
  if (!task.sandbox) {
    return undefined;
  }

  return {
    taskId: task.id,
    repoDir: task.sandbox.repoDir,
    artifactDir: task.sandbox.artifactDir,
    logDir: task.sandbox.logDir,
    mode: task.sandbox.mode,
  };
}

export function taskSandboxPatch(
  sandbox: Sandbox,
): NonNullable<Task["sandbox"]> {
  return {
    repoDir: sandbox.repoDir,
    artifactDir: sandbox.artifactDir,
    logDir: sandbox.logDir,
    mode: sandbox.mode,
  };
}

export function hydrateSandboxConfig(
  sandbox: Sandbox,
  config: AppConfig,
): Sandbox {
  return {
    ...sandbox,
    rootDir: path.resolve(config.rootDir, config.sandbox.root_dir),
    dockerImage: config.sandbox.image,
    networkAllowlist: config.sandbox.network.allow,
    filesystemAllowRepoOnly: config.sandbox.filesystem.allow_repo_only,
    docker: {
      memory: config.sandbox.docker.memory,
      cpus: config.sandbox.docker.cpus,
      pidsLimit: config.sandbox.docker.pids_limit,
    },
  };
}

export async function ensureSandboxDirectories(
  sandbox: Sandbox,
): Promise<void> {
  await Promise.all([
    mkdir(sandbox.repoDir, { recursive: true }),
    mkdir(sandbox.artifactDir, { recursive: true }),
    mkdir(sandbox.logDir, { recursive: true }),
  ]);
}
