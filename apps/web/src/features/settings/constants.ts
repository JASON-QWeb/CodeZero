import type { ConfigSectionName, TriggerMode } from "./types";

export const triggerModes: TriggerMode[] = ["auto", "mention", "label", "manual", "disabled"];
export const orderedSections: ConfigSectionName[] = [
  "agents",
  "repositories",
  "sandbox",
  "workflow_graph",
  "memory",
];
