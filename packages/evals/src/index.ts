import type { ContextPack, IssueContext, TaskTrace } from "@agent/shared";

export type GoldenIssueFixture = {
  id: string;
  title: string;
  issue: IssueContext;
  expected: {
    contextFiles?: string[];
    tests?: string[];
    routeEntrypoints?: string[];
    memoryKinds?: ContextPack["memories"][number]["kind"][];
    prBodySections?: string[];
    traceKinds?: TaskTrace["spans"][number]["kind"][];
  };
};

export type GoldenIssueCandidate = {
  contextPack?: ContextPack;
  navigationRoute?: {
    entrypoints: string[];
    tests?: string[];
  };
  prBody?: string;
  trace?: TaskTrace;
};

export type EvalAssertion = {
  id: string;
  label: string;
  passed: boolean;
  expected: string[];
  actual: string[];
};

export type EvalReport = {
  fixtureId: string;
  fixtureTitle: string;
  score: number;
  passed: number;
  total: number;
  assertions: EvalAssertion[];
};

export type GoldenIssueSuiteReport = {
  generatedAt: string;
  score: number;
  passed: number;
  total: number;
  fixtures: EvalReport[];
};

export function evaluateGoldenIssue(fixture: GoldenIssueFixture, candidate: GoldenIssueCandidate): EvalReport {
  const assertions: EvalAssertion[] = [];

  pushContainsAssertion(assertions, "context-files", "ContextPack contains expected files", fixture.expected.contextFiles, candidate.contextPack?.relevantFiles.map((file) => file.path));
  pushContainsAssertion(assertions, "tests", "ContextPack contains expected tests", fixture.expected.tests, candidate.contextPack?.tests);
  pushContainsAssertion(assertions, "routes", "Navigation route contains expected entrypoints", fixture.expected.routeEntrypoints, candidate.navigationRoute?.entrypoints);
  pushContainsAssertion(assertions, "memory-kinds", "ContextPack includes expected memory kinds", fixture.expected.memoryKinds, candidate.contextPack?.memories.map((memory) => memory.kind));
  pushSectionsAssertion(assertions, "pr-body", "PR body includes required sections", fixture.expected.prBodySections, candidate.prBody);
  pushContainsAssertion(assertions, "trace-kinds", "Trace includes expected span kinds", fixture.expected.traceKinds, candidate.trace?.spans.map((span) => span.kind));

  const passed = assertions.filter((assertion) => assertion.passed).length;
  const total = assertions.length;

  return {
    fixtureId: fixture.id,
    fixtureTitle: fixture.title,
    score: total === 0 ? 1 : Number((passed / total).toFixed(4)),
    passed,
    total,
    assertions
  };
}

export function evaluateGoldenIssueSuite(fixtures: GoldenIssueFixture[], candidates: Map<string, GoldenIssueCandidate>): GoldenIssueSuiteReport {
  const reports = fixtures.map((fixture) => evaluateGoldenIssue(fixture, candidates.get(fixture.id) ?? {}));
  const passed = reports.reduce((sum, report) => sum + report.passed, 0);
  const total = reports.reduce((sum, report) => sum + report.total, 0);

  return {
    generatedAt: new Date().toISOString(),
    score: total === 0 ? 1 : Number((passed / total).toFixed(4)),
    passed,
    total,
    fixtures: reports
  };
}

export function renderEvalReportMarkdown(report: GoldenIssueSuiteReport): string {
  const lines = [
    "# Golden Issue Eval Report",
    "",
    `- Score: ${formatPercent(report.score)}`,
    `- Passed: ${report.passed}/${report.total}`,
    `- Generated: ${report.generatedAt}`,
    "",
    "| Fixture | Score | Passed | Failed Assertions |",
    "| --- | ---: | ---: | --- |"
  ];

  for (const fixture of report.fixtures) {
    const failed = fixture.assertions.filter((assertion) => !assertion.passed).map((assertion) => assertion.id);
    lines.push(
      `| ${escapeTableCell(fixture.fixtureTitle)} | ${formatPercent(fixture.score)} | ${fixture.passed}/${fixture.total} | ${escapeTableCell(failed.join(", ") || "none")} |`
    );
  }

  lines.push("", "## Assertions", "");

  for (const fixture of report.fixtures) {
    lines.push(`### ${fixture.fixtureTitle}`, "");
    for (const assertion of fixture.assertions) {
      const icon = assertion.passed ? "PASS" : "FAIL";
      lines.push(`- ${icon} ${assertion.label}`);
      lines.push(`  - expected: ${assertion.expected.join(", ")}`);
      lines.push(`  - actual: ${assertion.actual.join(", ") || "none"}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}

function pushContainsAssertion(
  assertions: EvalAssertion[],
  id: string,
  label: string,
  expected: string[] | undefined,
  actual: string[] | undefined
): void {
  if (!expected || expected.length === 0) {
    return;
  }

  const actualValues = actual ?? [];
  assertions.push({
    id,
    label,
    passed: expected.every((value) => actualValues.includes(value)),
    expected,
    actual: actualValues
  });
}

function pushSectionsAssertion(assertions: EvalAssertion[], id: string, label: string, expected: string[] | undefined, body: string | undefined): void {
  if (!expected || expected.length === 0) {
    return;
  }

  assertions.push({
    id,
    label,
    passed: expected.every((section) => body?.includes(section)),
    expected,
    actual: body ? expected.filter((section) => body.includes(section)) : []
  });
}

function formatPercent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function escapeTableCell(value: string): string {
  return value.replaceAll("|", "\\|");
}
