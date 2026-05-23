import type { JsonObject, TaskEvent, TaskEventType } from "@agent/shared";

export function createTaskEvent(input: {
  taskId: string;
  type: TaskEventType;
  message: string;
  level?: TaskEvent["level"];
  metadata?: JsonObject;
}): TaskEvent {
  return {
    id: `event-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    taskId: input.taskId,
    type: input.type,
    level: input.level ?? "info",
    message: input.message,
    metadata: input.metadata,
    createdAt: new Date().toISOString()
  };
}
