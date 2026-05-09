import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export type FileIndexEntry = {
  path: string;
  extension: string;
  sizeBytes: number;
  isTest: boolean;
  isGenerated: boolean;
  moduleName: string;
  modifiedAt: string;
};

export type FileIndexOptions = {
  ignoreDirs?: string[];
  ignoreFiles?: string[];
};

const defaultIgnoreDirs = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", "coverage"]);
const generatedMarkers = ["generated", ".snap", ".lock"];

export async function indexFiles(repoDir: string, options: FileIndexOptions = {}): Promise<FileIndexEntry[]> {
  const ignoreDirs = new Set([...defaultIgnoreDirs, ...(options.ignoreDirs ?? [])]);
  const ignoreFiles = new Set(options.ignoreFiles ?? []);
  const entries: FileIndexEntry[] = [];

  async function visit(currentDir: string): Promise<void> {
    const dirents = await readdir(currentDir, { withFileTypes: true });

    for (const dirent of dirents) {
      const absolutePath = path.join(currentDir, dirent.name);
      const relativePath = path.relative(repoDir, absolutePath);

      if (dirent.isDirectory()) {
        if (!ignoreDirs.has(dirent.name)) {
          await visit(absolutePath);
        }
        continue;
      }

      if (!dirent.isFile() || ignoreFiles.has(dirent.name)) {
        continue;
      }

      const fileStat = await stat(absolutePath);
      const extension = path.extname(dirent.name);
      const moduleName = relativePath.split(path.sep)[0] ?? ".";

      entries.push({
        path: relativePath,
        extension,
        sizeBytes: fileStat.size,
        isTest: /\.(test|spec)\.[jt]sx?$/.test(dirent.name),
        isGenerated: generatedMarkers.some((marker) => relativePath.includes(marker)),
        moduleName,
        modifiedAt: fileStat.mtime.toISOString()
      });
    }
  }

  await visit(repoDir);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

