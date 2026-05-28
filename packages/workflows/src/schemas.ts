import { z } from "zod";

export const prdSchema = z.object({
  title: z.string(),
  background: z.string(),
  goals: z.array(z.string()).default([]),
  nonGoals: z.array(z.string()).default([]),
  userStories: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  unknowns: z.array(z.string()).default([]),
  taskType: z.enum(["frontend", "backend", "fullstack", "docs", "unknown"]).default("unknown"),
  complexity: z.object({
    score: z.number().min(0).max(100),
    requiresHumanReview: z.boolean(),
    reasons: z.array(z.string()).default([])
  })
});

export const planSchema = z.object({
  goal: z.string(),
  acceptanceCriteria: z.array(z.string()).default([]),
  filesToRead: z.array(z.string()).default([]),
  filesExpectedToChange: z.array(z.string()).default([]),
  testsToAddOrUpdate: z.array(z.string()).default([]),
  commandsToRun: z.array(z.string()).default([]),
  explicitNonGoals: z.array(z.string()).default([]),
  riskNotes: z.array(z.string()).default([])
});

export const planningDocumentSchema = prdSchema.extend({
  implementationPlan: planSchema
});

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
  missingTests: z.array(z.string()).default([]),
  scopeViolations: z.array(z.string()).default([]),
  riskLevel: z.enum(["low", "medium", "high"]).default("medium"),
  prDescriptionNotes: z.array(z.string()).default([])
});
