---
name: Agent task
about: Hand a scoped task to one agent (Codex = UI lane, Claude Code = Infra/DB/Ops/Docs lane)
title: "[Lane — Codex|Claude] Short task name"
---

## Goal
One or two sentences in plain language: what the Owner wants and why.

## Assigned agent and lane
- Agent: Codex (UI / Frontend) | Claude Code (Infra / DB / Ops / Docs)
- Branch to create: `codex/<issue>-<slug>` or `claude/<issue>-<slug>`

## In scope
-

## Out of scope
- Anything not listed above. No unapproved features, Production deploy, DNS, credential, or paid-resource changes.

## Inputs the Owner must supply
- Images, URLs, copy and decisions. Put them in this issue or the repo — never only in a chat.

## Acceptance criteria (PASS / FAIL / UNKNOWN)
-

## Risks and rollback
- Data/auth risk, backup needed, how to roll back (Worker rollback ≠ SQL rollback).

## Release
- Does it need a Production deploy? Deploys are serialized and require Owner approval and an exact reviewed SHA.
