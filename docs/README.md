# Documentation

This directory contains the current product, architecture, runtime, and operations documentation for CodeZero / Agent PRD Automation.

## Start Here

- [Core Product Flow](CORE_PRODUCT_FLOW.md): canonical Issue-to-PR product contract; keep this updated so future agents do not lose the main logic after context compaction.
- [Product Requirements](PRD.md): product goals, user stories, acceptance gates, and non-goals.
- [System Architecture](ARCHITECTURE.md): service layers, core components, and runtime responsibilities.
- [Workflow Blueprint](WORKFLOW_BLUEPRINT.md): end-to-end Issue-to-PR state flow.
- [Operations Guide](OPERATIONS.md): local setup, environment variables, service startup, and GitHub integration.
- [Session Review](../SESSION_REVIEW.md): session-level error review, fixes, and the current business route.

## Engineering Design

- [Agent Runtime Architecture](AGENT_RUNTIME_ARCHITECTURE.md): provider abstraction, agent contracts, tracing, tools, and guardrails.
- [Repo Navigation Graph](REPO_NAVIGATION_GRAPH.md): graph model for repository entry points, symbols, tests, routes, ownership, and history.
- [Codebase Intelligence](CODEBASE_INTELLIGENCE.md): indexing, agentic search, ContextPack, evidence scoring, and project map updates.
- [Context and Minimal Change](CONTEXT_AND_MINIMAL_CHANGE.md): context compression strategy and smallest-safe-change workflow.
- [Memory Architecture](MEMORY_ARCHITECTURE.md): approved memory, memory proposals, retrieval, and governance.
- [Issue Isolation and Quality Gates](ISSUE_ISOLATION_AND_QUALITY_GATES.md): sandbox isolation, branch policy, verification, and PR quality gates.
- [Prompt and Skill Design](PROMPTS_AND_SKILLS.md): platform skills, project skills, prompt versioning, and registry expectations.
- [Confirmed Decisions](DECISIONS.md): accepted product and architecture decisions.
