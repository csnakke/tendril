<style>
.cover h1 { font-size: 2.2em; margin-top: 4em; }
.cover .authors { margin-top: 3em; font-size: 1.1em; }
.cover .affil { color: #666; font-style: italic; }
.cover .meta { margin-top: 8em; color: #666; }
.abstract { margin: 0 3em 2em; font-size: .95em; }
.abstract h2 { border: none; text-align: center; font-size: 1.1em; }
</style>

<!-- cover -->
# {{title}}

<div class="authors">{{author}}</div>
<div class="affil">Department, Institution</div>

<div class="meta">{{date:MMMM YYYY}}</div>
<!-- /cover -->

<div class="abstract">

## Abstract

{{cursor}}

</div>

## 1. Introduction

## 2. Related work

## 3. Method

## 4. Experiments

## 5. Results

<!-- Sample data: double-click a chart in the preview, or right-click it in the editor, to edit it. -->

```chart
type: bar3d
title: Accuracy by dataset
caption: Higher is better.
categories: [Dataset A, Dataset B, Dataset C]
series:
  - { name: Baseline, values: [71.2, 64.5, 80.1] }
  - { name: Proposed, values: [78.9, 70.3, 84.6] }
options:
  suffix: "%"
  min: 50
  max: 100
  valueTitle: Accuracy
```

## 6. Conclusion

<!-- pagebreak -->

## References

1. 
