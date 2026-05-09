---
name: pr-compliance-review
version: 0.1.0
---

# PR Compliance Review

Before creating a draft PR, review the PRD, ContextPack, minimal change plan, diff, quality gate results, and screenshots.

Block PR creation when:

- Acceptance criteria are not met.
- Diff contains unrelated changes.
- Current Issue includes another Issue's diff.
- Build, lint, test, or typecheck failed.
- Frontend screenshot is missing for frontend work.
- Backend unit test is missing for backend work.
- Security, permissions, payments, or destructive data changes lack human approval.

