---
title: {{title}}
created: {{date}}
time: {{time}}
author: {{author}}
status: draft
priority: 2
reviewed: false
tags: [note, example]
project:
related: https://github.com
description:
---

# {{title}}

<!-- Everything below is an example of what a note template can contain.
     HTML comments like this one are hidden in the preview and exports,
     so use them for instructions to whoever uses the template. -->

## Contents

<!-- toc -->
<!-- tocstop -->

## Summary

{{cursor}}

## Properties above

The block at the very top of this file is YAML **front matter**. Each key becomes a
property:

- `status`, `project` — text (`project:` is empty on purpose)
- `priority` — a number, kept as a number when edited
- `reviewed` — a boolean, shown as a checkbox
- `tags` — a list, shown as tags; edit as `a, b, c`
- `related` — a URL, rendered as a link
- `created`, `time`, `author` — filled from placeholders when the note is created

In **Edit** view the block turns into an editable properties panel; click into it
(or press `</>`) to see the YAML.

## Formatting

Text can be **bold**, *italic*, ***both***, ~~struck through~~ or `inline code`.
Links look like [this](https://example.com), and a footnote-style reference can
point to a heading: [Summary](#summary).

> Block quotes for callouts, citations or anything set apart.
> They can span several lines.

### Lists

- Bullet item
- Another one
  - Nested item
    - Deeper

1. Numbered
2. List
   1. Nested numbering

### Tasks

- [ ] Something to do
- [x] Something done
- [ ] Click the box in Edit view to toggle it

### Table

| Column | Type | Notes |
|--------|:----:|------:|
| Left   | centre | right-aligned |
| Cells  | can | hold `code` and **bold** |

### Code

```ts
// Fenced code keeps its language for exports.
export function greet(name: string): string {
  return `Hello, ${name}`
}
```

### Image and rule

![Alt text shows if the image is missing](https://via.placeholder.com/320x80.png?text=Image)

---

## Headings and numbering

Press **Ctrl+Shift+N** to number the headings in this note (H2–H4 become 1, 1.1, 1.1.1);
**Ctrl+Shift+T** refreshes the table of contents at the top. Both are re-applied every
time the file is saved, so the structure never goes stale.

### Third level

#### Fourth level

Fifth and sixth levels exist but are not numbered or listed in the TOC by default.

## Tips for template authors

- Keep instructions in `<!-- comments -->` so they never appear in the output.
- Put `{{cursor}}` where writing should start.
- Use `{{date:dddd, D MMMM YYYY}}` for long dates and `{{date:YYYY-MM-DD}}` for sortable ones.
- Save the file anywhere in the templates folder; a template with no cover, page break
  or `<style>` is listed under **Notes**.
