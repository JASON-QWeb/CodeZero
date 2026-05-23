import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TaskRepository } from "@agent/persistence";
import type { Artifact, JsonObject } from "@agent/shared";

export type WriteTaskArtifactInput = {
  rootDir: string;
  tasks: TaskRepository;
  taskId: string;
  type: Artifact["type"];
  fileName: string;
  content: string;
  metadata?: JsonObject;
};

export async function writeTaskArtifact(input: WriteTaskArtifactInput): Promise<Artifact> {
  const artifactDir = path.resolve(input.rootDir, "artifacts", input.taskId);
  await mkdir(artifactDir, { recursive: true });
  const artifactPath = path.join(artifactDir, input.fileName);
  await writeFile(artifactPath, input.content);

  const artifact: Artifact = {
    id: createArtifactId(),
    taskId: input.taskId,
    type: input.type,
    path: artifactPath,
    metadata: input.metadata,
    createdAt: new Date().toISOString()
  };

  await input.tasks.addArtifact(artifact);
  return artifact;
}

export function createArtifactId(): string {
  return `artifact-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
