export type ProjectMapUpdate = {
  title: string;
  rationale: string;
  suggestedFiles: Array<{
    path: string;
    content: string;
  }>;
};

export function proposeProjectMapUpdate(input: {
  issueTitle: string;
  changedFiles: string[];
  testCommands: string[];
}): ProjectMapUpdate {
  return {
    title: `Project map update for ${input.issueTitle}`,
    rationale: "Capture newly discovered module ownership and verification patterns for future agentic search.",
    suggestedFiles: [
      {
        path: ".agent/change-patterns.md",
        content: [
          `# Change Pattern: ${input.issueTitle}`,
          "",
          "## Changed Files",
          ...input.changedFiles.map((file) => `- ${file}`),
          "",
          "## Verification",
          ...input.testCommands.map((command) => `- ${command}`)
        ].join("\n")
      }
    ]
  };
}

