<style>
.cover h1 { font-size: 2.8em; margin-bottom: .3em; }
.cover .subtitle { font-size: 1.3em; color: #666; }
.cover .meta { margin-top: 5em; color: #666; line-height: 1.7; }
.cover .org { margin-top: 6em; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; font-size: .9em; }
</style>

<!-- cover -->
# {{title}}

<div class="subtitle">Technical Report</div>

<div class="meta">{{author}}<br>{{date:D MMMM YYYY}}</div>

<div class="org">Organisation</div>
<!-- /cover -->

## Contents

<!-- toc -->
<!-- tocstop -->

<!-- pagebreak -->

## Abstract

{{cursor}}

## Introduction

## Method

## Results

<!-- Sample data: double-click a chart in the preview, or right-click it in the editor, to edit it. -->

```chart
type: pie3d
title: Findings by severity
palette: severity
data:
  - { label: Critical, value: 1 }
  - { label: High, value: 3 }
  - { label: Medium, value: 5 }
  - { label: Low, value: 4 }
  - { label: Info, value: 2 }
options:
  explode: [Critical]
```

```chart
type: bar3d
title: Findings by category
palette: severity
categories: [Authentication, Configuration, Injection, Exposure]
series:
  - { name: Critical, values: [1, 0, 0, 0] }
  - { name: High, values: [1, 1, 1, 0] }
  - { name: Medium, values: [1, 2, 0, 2] }
  - { name: Low, values: [0, 2, 1, 1] }
options:
  stacked: true
  valueTitle: Findings
```

## Discussion

## Conclusion

<!-- pagebreak -->

## References

1. 
