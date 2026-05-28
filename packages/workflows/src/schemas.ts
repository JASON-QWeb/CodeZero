import { z } from "zod";

const stringArraySchema = z.preprocess((value) => {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "string") {
    return value.trim() ? [value] : [];
  }

  return value;
}, z.array(z.string()).default([]));

export const prdSchema = z.object({
  title: z.string(),
  background: z.string(),
  goals: stringArraySchema,
  nonGoals: stringArraySchema,
  userStories: stringArraySchema,
  acceptanceCriteria: stringArraySchema,
  risks: stringArraySchema,
  unknowns: stringArraySchema,
  taskType: z.enum(["frontend", "backend", "fullstack", "docs", "unknown"]).default("unknown"),
  complexity: z.object({
    score: z.number().min(0).max(100),
    requiresHumanReview: z.boolean(),
    reasons: stringArraySchema
  })
});

export const planSchema = z.object({
  goal: z.string(),
  acceptanceCriteria: stringArraySchema,
  filesToRead: stringArraySchema,
  filesExpectedToChange: stringArraySchema,
  testsToAddOrUpdate: stringArraySchema,
  commandsToRun: stringArraySchema,
  explicitNonGoals: stringArraySchema,
  riskNotes: stringArraySchema
});

export const planningDocumentSchema = z.preprocess((value) => {
  if (!isRecord(value)) {
    return value;
  }

  const document = { ...value };
  const implementationPlan = isRecord(document.implementationPlan)
    ? { ...document.implementationPlan }
    : {};

  if (typeof implementationPlan.goal !== "string" || !implementationPlan.goal.trim()) {
    implementationPlan.goal =
      firstString(document.goals) ??
      firstString(document.acceptanceCriteria) ??
      (typeof document.title === "string" && document.title.trim()
        ? document.title.trim()
        : "Implement the requested issue");
  }

  document.implementationPlan = implementationPlan;
  return document;
}, prdSchema.extend({
  implementationPlan: planSchema
}));

const reviewFindingSchema = z.object({
  title: z.string(),
  body: z.string(),
  blocking: z.boolean(),
  file: z.preprocess((value) => (value === null ? undefined : value), z.string().optional())
});

export const reviewSchema = z.object({
  approved: z.boolean(),
  blockingFindings: z.array(reviewFindingSchema).default([]),
  nonBlockingFindings: z.array(reviewFindingSchema).default([]),
  missingTests: stringArraySchema,
  scopeViolations: stringArraySchema,
  riskLevel: z.enum(["low", "medium", "high"]).default("medium"),
  prDescriptionNotes: stringArraySchema
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  return value
    .find(
      (entry): entry is string =>
        typeof entry === "string" && entry.trim().length > 0,
    )
    ?.trim();
}
