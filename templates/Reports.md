<style>
/* Document styles are scoped to this document. Use them for the cover and
   any report-specific typography. @page controls the printed sheet. */
@page { size: A4; margin: 20mm 18mm; }

.cover h1 { font-size: 2.8em; margin: 0 0 .2em; border: none; }
.cover .subtitle { font-size: 1.3em; color: #666; }
.cover .meta { margin-top: 5em; line-height: 1.8; color: #555; }
.cover .meta b { color: #222; }
.cover .org { margin-top: 6em; font-size: .85em; letter-spacing: .12em; text-transform: uppercase; color: #888; }

h2 { border-bottom: 2px solid #2f6fb3; }
h2, h3 { break-after: avoid; }
table { break-inside: avoid; }
.note { padding: 8px 12px; border-left: 4px solid #2f6fb3; background: #eef4fb; }
.signatures td { height: 3em; vertical-align: bottom; }
</style>

<!-- cover -->
# {{title}}

<div class="subtitle">Report subtitle or document type</div>

<div class="meta"><b>Prepared by</b> {{author}}<br><b>Date</b> {{date:D MMMM YYYY}}<br><b>Version</b> 1.0</div>

<div class="org">Organisation · Department</div>
<!-- /cover -->

<!-- The cover is its own page. Everything between the cover markers is
     vertically centred on the sheet; style it with `.cover …` selectors above. -->

## Contents

<!-- toc -->
<!-- tocstop -->

<!-- pagebreak -->

## Executive summary

{{cursor}}

<div class="note">Raw HTML works anywhere. Classes defined in the style block apply here.</div>

## Introduction

### Purpose

### Scope

<!-- pagebreak -->

## Findings

### Overview

| Area | Status | Owner |
|------|:------:|-------|
| Item one | ✅ | |
| Item two | ⚠️ | |
| Item three | ❌ | |

```chart
type: pie3d
title: Findings by severity
palette: severity
data:
  - { label: Critical, value: 1 }
  - { label: High, value: 2 }
  - { label: Medium, value: 4 }
  - { label: Low, value: 3 }
options:
  explode: [Critical]
```

### Detail

1. First finding
2. Second finding
   - Supporting point
   - Supporting point

> Quoted material or a highlighted statement.

```text
Fenced code blocks keep their formatting and never split awkwardly across pages.
```

<!-- pagebreak -->

## Recommendations

- [ ] Recommendation one
- [ ] Recommendation two

## Next steps

| # | Action | Owner | Due |
|---|--------|-------|-----|
| 1 |        |       |     |
| 2 |        |       |     |

## Approval

<table class="signatures">
<tr><th>Role</th><th>Name</th><th>Signature</th><th>Date</th></tr>
<tr><td>Author</td><td>{{author}}</td><td></td><td></td></tr>
<tr><td>Reviewer</td><td></td><td></td><td></td></tr>
<tr><td>Approver</td><td></td><td></td><td></td></tr>
</table>

<!-- pagebreak -->

## Appendix A — How this template works

- `<!-- cover -->` … `<!-- /cover -->` makes the cover page.
- `<!-- pagebreak -->` starts a new page. Put each marker on its own line at the top level.
- The `<style>` block at the top is applied only to this document (preview, HTML and PDF).
- A ` ```chart ` block draws a 3D pie or bar chart. Double-click it in the preview (or press
  **Ctrl+Alt+G** inside it) to edit the data and style in the chart editor.
- The preview shows the report as A4 sheets. PDF export adds the title and date in the
  header and *Page n of m* in the footer.
- **Ctrl+Shift+N** numbers the headings (1, 1.1, 1.1.1); **Ctrl+Shift+T** fills the
  contents list. Both refresh on save.
- Placeholders such as the title, author and date were filled in when this document
  was created; see README.md in the templates folder for the full list.
