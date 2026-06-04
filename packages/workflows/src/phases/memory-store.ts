import type { AppConfig } from "@agent/config";
import { FileMemoryStore } from "@agent/memory";

export function createConfiguredMemoryStore(
  config: AppConfig,
): FileMemoryStore {
  return new FileMemoryStore(config.memory.filePath, {
    maxRecords: config.memory.maxRecords,
    maxBytes: config.memory.maxBytes,
    maxRecordBytes: config.memory.maxRecordBytes,
  });
}
