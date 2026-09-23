# Tendril templates

Point **Settings → Templates → Templates folder** at this folder (or copy the files
into your own). Every `.md` file here appears under **File → New from Template**
(Ctrl+Alt+N) and in the explorer's right-click menu, *New from Template Here…*.

| File | Kind | What it shows |
|------|------|---------------|
| `Note template.md` | Note | Front-matter properties of every type, placeholders, all Markdown features Tendril renders |
| `Report template.md` | Report | Cover page, page breaks, document styles, TOC, numbering, print header/footer |

How a file is classified: it is a **report** if it contains `<!-- cover -->`,
`<!-- pagebreak -->` or a `<style>` block, otherwise a **note**. Subfolders
`notes/` and `reports/` force the kind.

## Placeholders

Expanded once, when the document is created.

| Placeholder | Result |
|-------------|--------|
| `{{title}}` | Title typed in the picker (also the suggested file name) |
| `{{author}}` | Settings → Templates → Author |
| `{{date}}` | Today as `YYYY-MM-DD` |
| `{{date:FORMAT}}` | Today in a custom format, e.g. `{{date:dddd, D MMMM YYYY}}` → *Sunday, 20 September 2026* |
| `{{time}}` | Now as `HH:mm` |
| `{{time:FORMAT}}` | e.g. `{{time:HH:mm:ss}}` |
| `{{filename}}` | File name without `.md` |
| `{{cursor}}` | Removed; the caret lands here |

Format tokens: `YYYY` `YY` `MMMM` `MMM` `MM` `M` `DD` `D` `dddd` `ddd` `HH` `mm` `ss`.
Anything else (`{{foo}}`) is left as written.

## Notes: front matter (properties)

A YAML block on the very first line:

```yaml
---
title: My note          # string
date: 2026-09-20        # dates stay plain strings
count: 3                # number
done: false             # boolean → checkbox
tags: [a, b]            # list → tags
link: https://x.y       # URLs become links in the preview
empty:                  # empty value
---
```

- Preview and exports show it as a properties table.
- In Edit view (live preview) it is an editable panel: click a value to change it,
  hover a row for ✕, *+ Add property*, or `</>` to edit the YAML by hand.
- `title:` becomes the document title used for PDF/HTML exports.

## Reports: layout markers

| Marker | Effect |
|--------|--------|
| `<!-- cover -->` … `<!-- /cover -->` | Cover page (its own sheet; content vertically centred) |
| `<!-- pagebreak -->` | Start a new page |
| `<style> … </style>` | Document CSS, scoped to the document body; `@page` and `@font-face` stay global |

Markers must start at the beginning of a line at top level (not inside lists or quotes).
A report is previewed as A4 sheets and exported to PDF with `Page n of m` in the footer
and the title/date in the header.

Useful selectors for the `<style>` block: `.cover`, `.cover h1`, `.page`, `h1`…`h6`,
`table`, `blockquote`, `pre`, `.properties`.

## Markdown that Tendril renders

Headings, emphasis, ~~strikethrough~~, `code`, fenced code, links, images, block quotes,
bullet / numbered / task lists, tables, horizontal rules, raw HTML, and:

| Feature | How |
|---------|-----|
| Table of contents | Put `<!-- toc -->` and `<!-- tocstop -->` where it should go; Ctrl+Shift+T fills/refreshes it (also on save) |
| Heading numbering | Ctrl+Shift+N numbers H2–H4 like Word (1, 1.1, 1.1.1); refreshed on save |
| Live preview | Ctrl+Shift+L; the line under the cursor shows raw Markdown |
| Images | Toolbar **Image** (Ctrl+Alt+I), drag & drop or paste: copied to `./assets/` beside the note and linked as `![name](./assets/name.png)` |
| Tables | Toolbar **Table** (Ctrl+Alt+T) inserts one from a size grid; right-click inside it for Insert/Delete, Merge and Center, Shading, Font Color, Banded Rows, Wrap Text; Tab moves between cells. Stored as app-managed comments (`<!-- table: banded -->`, `<!--bg:#ffc000-->`) that GitHub ignores |
| 3D charts | Toolbar **Chart** (Ctrl+Alt+G) opens the chart editor for a 3D bar or 3D pie; double-click a chart to edit it. Stored as a ` ```chart ` block of YAML (`type`, `title`, `palette`, `data` or `categories` + `series`, `options`). *Save as SVG to assets/* optionally adds an image link for viewers without Tendril |
