import type { JsonObject } from "@agent/shared";
import { asJsonValue, isRecord } from "./utils.js";
import type { JsonActionPlan, JsonToolAction, ToolCallResult, ToolExecutionContext } from "./types.js";
import type { ToolGateway } from "./gateway.js";

export function parseJsonActionPlan(content: string): JsonActionPlan {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced ?? trimmed;
  const parsed = JSON.parse(candidate) as unknown;

  if (!isRecord(parsed)) {
    throw new Error("JSON action response must be an object");
  }

  if (Array.isArray(parsed.actions)) {
    return {
      actions: parsed.actions.map((action) => parseJsonToolAction(action))
    };
  }

  return {
    actions: [parseJsonToolAction(parsed)]
  };
}

export async function runJsonActionPlan(input: {
  gateway: ToolGateway;
  plan: JsonActionPlan;
  context: ToolExecutionContext;
  taskId?: string;
  continueOnError?: boolean;
}): Promise<ToolCallResult[]> {
  const results: ToolCallResult[] = [];

  for (const action of input.plan.actions) {
    const result = await input.gateway.execute(
      {
        id: action.id,
        taskId: input.taskId ?? input.context.taskId,
        toolName: action.toolName,
        input: action.input
      },
      input.context
    );
    results.push(result);

    if (result.status !== "success" && !input.continueOnError) {
      break;
    }
  }

  return results;
}

function parseJsonToolAction(value: unknown): JsonToolAction {
  if (!isRecord(value)) {
    throw new Error("JSON action must be an object");
  }

  const toolName = typeof value.toolName === "string" ? value.toolName : typeof value.tool === "string" ? value.tool : undefined;

  if (!toolName) {
    throw new Error("JSON action requires toolName or tool");
  }

  if (!isRecord(value.input)) {
    throw new Error(`JSON action ${toolName} requires object input`);
  }

  return {
    id: typeof value.id === "string" ? value.id : undefined,
    toolName,
    input: asJsonValue(value.input) as JsonObject
  };
}
