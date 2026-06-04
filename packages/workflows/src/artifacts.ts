import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TaskRepository } from "@agent/persistence";
import { pathExists, type Artifact, type JsonObject } from "@agent/shared";

export type WriteTaskArtifactInput = {
  rootDir: string;
  tasks: TaskRepository;
  taskId: string;
  type: Artifact["type"];
  fileName: string;
  content: string;
  metadata?: JsonObject;
};

export async function writeTaskArtifact(
  input: WriteTaskArtifactInput,
): Promise<Artifact> {
  const artifactDir = path.resolve(input.rootDir, "artifacts", input.taskId);
  await mkdir(artifactDir, { recursive: true });
  const artifactPath = await createAvailableArtifactPath(
    artifactDir,
    input.fileName,
  );
  await writeFile(artifactPath, input.content);

  const artifact: Artifact = {
    id: createArtifactId(),
    taskId: input.taskId,
    type: input.type,
    path: artifactPath,
    metadata: input.metadata,
    createdAt: new Date().toISOString(),
  };

  await input.tasks.addArtifact(artifact);
  return artifact;
}

export function createArtifactId(): string {
  return `artifact-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function createAvailableArtifactPath(
  artifactDir: string,
  fileName: string,
): Promise<string> {
  const requestedPath = path.join(artifactDir, fileName);

  if (!(await pathExists(requestedPath))) {
    return requestedPath;
  }

  const parsed = path.parse(fileName);

  for (let attempt = 1; ; attempt += 1) {
    const suffix = `${Date.now()}-${attempt}-${Math.random().toString(16).slice(2, 8)}`;
    const candidate = path.join(
      artifactDir,
      `${parsed.name}.${suffix}${parsed.ext}`,
    );

    if (!(await pathExists(candidate))) {
      return candidate;
    }
  }
}
