import { evaluateToolPolicies } from "./policies.js";
import {
  type PolicyDefinition,
  type ToolCallRequest,
  type ToolCallResult,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolHandler
} from "./types.js";
import { asJsonValue, withTimeout } from "./utils.js";

type RegisteredTool = {
  definition: ToolDefinition;
  handler: ToolHandler;
};

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(definition: ToolDefinition, handler: ToolHandler): void {
    if (this.tools.has(definition.name)) {
      throw new Error(`Tool already registered: ${definition.name}`);
    }

    this.tools.set(definition.name, { definition, handler });
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => tool.definition);
  }
}

export class ToolGateway {
  constructor(
    private readonly input: {
      registry: ToolRegistry;
      policies?: PolicyDefinition[];
    }
  ) {}

  async execute(request: ToolCallRequest, context: ToolExecutionContext): Promise<ToolCallResult> {
    const startedAt = Date.now();
    const id = request.id ?? `tool-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const registered = this.input.registry.get(request.toolName);

    if (!registered) {
      return {
        id,
        taskId: request.taskId,
        toolName: request.toolName,
        status: "failed",
        error: `Unknown tool: ${request.toolName}`,
        durationMs: Date.now() - startedAt,
        policyDecisions: []
      };
    }

    const policyDecisions = evaluateToolPolicies({
      tool: registered.definition,
      request,
      policies: this.input.policies ?? []
    });
    const blockingDecision = policyDecisions.find((decision) => decision.action === "block");

    if (blockingDecision) {
      return {
        id,
        taskId: request.taskId,
        toolName: request.toolName,
        status: "blocked",
        error: blockingDecision.reasons.join("; "),
        durationMs: Date.now() - startedAt,
        policyDecisions
      };
    }

    const approvalDecision = policyDecisions.find((decision) => decision.action === "require_approval");

    if (approvalDecision) {
      return {
        id,
        taskId: request.taskId,
        toolName: request.toolName,
        status: "approval_required",
        error: approvalDecision.reasons.join("; "),
        durationMs: Date.now() - startedAt,
        policyDecisions
      };
    }

    try {
      const output = await withTimeout(
        Promise.resolve(registered.handler(request.input, { ...context, taskId: request.taskId ?? context.taskId })),
        registered.definition.timeoutMs ?? 30_000,
        registered.definition.name
      );

      return {
        id,
        taskId: request.taskId,
        toolName: request.toolName,
        status: "success",
        output: asJsonValue(output),
        durationMs: Date.now() - startedAt,
        policyDecisions
      };
    } catch (error) {
      return {
        id,
        taskId: request.taskId,
        toolName: request.toolName,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
        policyDecisions
      };
    }
  }
}
