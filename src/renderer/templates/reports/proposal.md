<style>
.cover { justify-content: flex-start; padding-top: 25%; text-align: left; }
.cover h1 { font-size: 3em; border-bottom: 4px solid #2f6fb3; padding-bottom: .3em; }
.cover .subtitle { font-size: 1.4em; color: #2f6fb3; }
.cover .meta { margin-top: 6em; color: #666; line-height: 1.8; }
.cover .meta b { color: #333; }
h2 { border-bottom: 2px solid #2f6fb3; }
</style>

<!-- cover -->
# {{title}}

<div class="subtitle">Project Proposal</div>

<div class="meta"><b>Prepared by</b> {{author}}<br><b>Date</b> {{date:D MMMM YYYY}}<br><b>Version</b> 0.1 — Draft</div>
<!-- /cover -->

## Executive summary

{{cursor}}

## Problem statement

## Proposed solution

## Scope

### In scope

### Out of scope

<!-- pagebreak -->

## Timeline

| Phase | Deliverable | Date |
|-------|-------------|------|
| 1     |             |      |
| 2     |             |      |

<!-- Sample data: double-click a chart in the preview, or right-click it in the editor, to edit it. -->

```chart
type: bar3d
title: Effort by phase
data:
  - { label: Discovery, value: 10 }
  - { label: Build, value: 35 }
  - { label: Test, value: 15 }
  - { label: Rollout, value: 8 }
options:
  horizontal: true
  suffix: " d"
  valueTitle: Person-days
```

## Budget

| Item | Cost |
|------|-----:|
|      |      |

```chart
type: pie3d
title: Budget allocation
palette: mono
data:
  - { label: Staff, value: 60000 }
  - { label: Licences, value: 15000 }
  - { label: Hardware, value: 12000 }
  - { label: Contingency, value: 8000 }
options:
  donut: 0.45
  labels: percent
```

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
|      |           |        |            |

## Approval

| Role | Name | Signature | Date |
|------|------|-----------|------|
| Sponsor |   |           |      |
