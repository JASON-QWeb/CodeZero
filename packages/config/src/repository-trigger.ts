import type { RepositoryConfig, RepositoryTriggerMode } from "./schema.js";

export type RepositoryTriggerDecisionInput = {
  repository?: RepositoryConfig;
  eventName: string;
  action: string;
  labels?: string[];
  commentBody?: string;
  actor?: string;
  fallbackMention?: string;
};

export type RepositoryTriggerDecision = {
  shouldTrigger: boolean;
  trigger: RepositoryTriggerMode | "unconfigured";
  reason: string;
  mention?: string;
};

export function evaluateRepositoryTrigger(input: RepositoryTriggerDecisionInput): RepositoryTriggerDecision {
  const repository = input.repository;

  if (!repository) {
    return {
      shouldTrigger: false,
      trigger: "unconfigured",
      reason: "Repository is not configured"
    };
  }

  const trigger = repository.trigger;
  const labels = new Set((input.labels ?? []).map(normalizeForCompare).filter(Boolean));
  const actor = input.actor ? normalizeForCompare(input.actor) : undefined;
  const eventKey = `${input.eventName}.${input.action}`;

  if (trigger.mode === "disabled") {
    return { shouldTrigger: false, trigger: trigger.mode, reason: "Repository trigger mode is disabled" };
  }

  if (trigger.mode === "manual") {
    return { shouldTrigger: false, trigger: trigger.mode, reason: "Repository trigger mode is manual" };
  }

  if (trigger.actor_allowlist.length > 0 && (!actor || !trigger.actor_allowlist.map(normalizeForCompare).includes(actor))) {
    return { shouldTrigger: false, trigger: trigger.mode, reason: "Actor is not allowlisted" };
  }

  const blockedLabel = trigger.label_blocklist.map(normalizeForCompare).find((label) => labels.has(label));

  if (blockedLabel) {
    return { shouldTrigger: false, trigger: trigger.mode, reason: `Issue has blocked label ${blockedLabel}` };
  }

  if (trigger.mode === "auto") {
    const shouldTrigger = trigger.auto_events.includes(eventKey);
    return {
      shouldTrigger,
      trigger: trigger.mode,
      reason: shouldTrigger ? `Matched auto event ${eventKey}` : `Auto mode does not include event ${eventKey}`
    };
  }

  if (trigger.mode === "label") {
    const allowlist = trigger.label_allowlist.map(normalizeForCompare);
    const matchedLabel = allowlist.find((label) => labels.has(label));
    return {
      shouldTrigger: Boolean(matchedLabel),
      trigger: trigger.mode,
      reason: matchedLabel ? `Matched allowlisted label ${matchedLabel}` : "Issue does not contain an allowlisted label"
    };
  }

  const mention = trigger.mention || input.fallbackMention || "@agent-prd";

  if (input.eventName !== "issue_comment" || input.action !== "created") {
    return {
      shouldTrigger: false,
      trigger: trigger.mode,
      reason: "Mention mode only triggers on issue_comment.created",
      mention
    };
  }

  const shouldTrigger = containsCaseInsensitive(input.commentBody ?? "", mention);

  return {
    shouldTrigger,
    trigger: trigger.mode,
    reason: shouldTrigger ? `Comment contains trigger mention ${mention}` : `Comment does not contain trigger mention ${mention}`,
    mention
  };
}

function containsCaseInsensitive(value: string, needle: string): boolean {
  return normalizeForCompare(value).includes(normalizeForCompare(needle));
}

function normalizeForCompare(value: string): string {
  return value.trim().toLowerCase();
}
