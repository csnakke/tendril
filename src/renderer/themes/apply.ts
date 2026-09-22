import { EditorView } from 'codemirror'
import type { Extension } from '@codemirror/state'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import type { ThemePalette } from '../../preload/index'
import { mix } from './obsidianImport'

/** Stylesheet defaults (GitHub-like); used when a theme lacks the active mode. */
export const FALLBACK: Record<'light' | 'dark', ThemePalette> = {
  light: {
    bg: '#ffffff', barBg: '#f6f8fa', border: '#d0d7de', fg: '#1f2328', muted: '#57606a',
    hover: '#eaeef2', active: '#dfe4ea', inset: '#e7ebef', selection: '#ddf4ff', accent: '#0969da',
    syntax: { heading: '#cf222e', emphasis: '#953800', link: '#0969da', code: '#116329', quote: '#57606a', meta: '#6e7781', keyword: '#cf222e', string: '#0a3069', comment: '#6e7781' }
  },
  dark: {
    bg: '#0d1117', barBg: '#161b22', border: '#30363d', fg: '#e6edf3', muted: '#8b949e',
    hover: '#21262d', active: '#2a3038', inset: '#0d1117', selection: '#1c2d45', accent: '#2f81f7',
    syntax: { heading: '#ff7b72', emphasis: '#ffa657', link: '#79c0ff', code: '#7ee787', quote: '#8b949e', meta: '#8b949e', keyword: '#ff7b72', string: '#a5d6ff', comment: '#8b949e' }
  }
}

const TOKENS: [keyof ThemePalette, string][] = [
  ['bg', '--bg'], ['barBg', '--bar-bg'], ['border', '--border'], ['fg', '--fg'], ['muted', '--muted'],
  ['hover', '--hover'], ['active', '--active'], ['inset', '--inset'], ['selection', '--selection'], ['accent', '--accent']
]

/** Push palette colours into the chrome tokens on :root. */
export function applyChrome(p: ThemePalette): void {
  const root = document.documentElement.style
  for (const [key, token] of TOKENS) root.setProperty(token, p[key] as string)
  root.setProperty('--highlight', p.highlightBg ?? p.selection)
}

/** Overrides layered on github-markdown-css so the preview follows the palette. */
export function previewCss(p: ThemePalette): string {
  const codeBg = p.codeBg ?? p.inset
  const heading = p.headingColor ?? p.fg
  const link = p.linkColor ?? p.accent
  const hr = p.hrColor ?? p.border
  return `
.markdown-body { color: ${p.fg}; background-color: ${p.bg}; }
.markdown-body :is(h1, h2, h3, h4, h5, h6) { color: ${heading}; }
.markdown-body :is(h1, h2) { border-bottom-color: ${hr}; }
.markdown-body a { color: ${link}; }
.markdown-body hr { background-color: ${hr}; }
.markdown-body :is(code, tt, kbd) { background-color: ${codeBg}; color: ${p.fg}; }
.markdown-body :is(pre, .highlight pre) { background-color: ${codeBg}; color: ${p.fg}; }
.markdown-body blockquote { color: ${p.muted}; border-left-color: ${p.blockquoteBorder ?? p.border}; }
.markdown-body :is(table th, table td) { border-color: ${p.border}; }
.markdown-body table tr { background-color: ${p.bg}; border-top-color: ${p.border}; }
.markdown-body table tr:nth-child(2n) { background-color: ${p.barBg}; }
.markdown-body mark { background-color: ${p.highlightBg ?? p.selection}; color: inherit; }
.markdown-body img { background-color: ${p.bg}; }
.markdown-body :is(.task-list-item, li)::marker { color: ${p.muted}; }
`
}

/** A CodeMirror theme + Markdown highlight style generated from the palette. */
export function editorExtension(p: ThemePalette, mode: 'light' | 'dark'): Extension {
  const s = p.syntax ?? {}
  const heading = s.heading ?? p.accent
  const activeLine = `color-mix(in srgb, ${p.hover} 45%, transparent)`
  const theme = EditorView.theme(
    {
      '&': { color: p.fg, backgroundColor: p.bg },
      '.cm-content': { caretColor: p.fg },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: p.fg },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: p.selection
      },
      // Line backgrounds paint over the selection layer, so they must stay translucent.
      '.cm-activeLine': { backgroundColor: activeLine },
      '.cm-gutters': { backgroundColor: p.bg, color: p.muted, border: 'none' },
      '.cm-activeLineGutter': { backgroundColor: activeLine, color: p.fg },
      '.cm-selectionMatch': { backgroundColor: mix(p.accent, p.bg, 0.25) },
      '&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket': { backgroundColor: mix(p.accent, p.bg, 0.3) },
      '.cm-foldPlaceholder': { backgroundColor: p.inset, borderColor: p.border, color: p.muted },
      '.cm-tooltip': { backgroundColor: p.barBg, border: `1px solid ${p.border}`, color: p.fg },
      '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: p.selection, color: p.fg },
      '.cm-panels': { backgroundColor: p.barBg, color: p.fg },
      '.cm-searchMatch': { backgroundColor: p.highlightBg ?? mix(p.accent, p.bg, 0.3) },
      '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: mix(p.accent, p.bg, 0.5) }
    },
    { dark: mode === 'dark' }
  )
  const highlight = HighlightStyle.define([
    { tag: t.heading, color: heading, fontWeight: 'bold' },
    { tag: t.strong, fontWeight: 'bold' },
    { tag: t.emphasis, fontStyle: 'italic', color: s.emphasis ?? p.fg },
    { tag: t.strikethrough, textDecoration: 'line-through' },
    { tag: [t.link, t.url], color: s.link ?? p.accent },
    { tag: t.monospace, color: s.code ?? p.fg },
    { tag: t.quote, color: s.quote ?? p.muted },
    { tag: [t.processingInstruction, t.meta, t.contentSeparator, t.labelName], color: s.meta ?? p.muted },
    { tag: t.comment, color: s.comment ?? p.muted, fontStyle: 'italic' },
    { tag: [t.keyword, t.operator, t.tagName], color: s.keyword ?? p.accent },
    { tag: [t.string, t.special(t.string), t.attributeValue], color: s.string ?? p.fg },
    { tag: [t.number, t.bool, t.atom, t.literal], color: s.emphasis ?? p.fg },
    { tag: [t.function(t.variableName), t.definition(t.variableName), t.className, t.typeName], color: s.link ?? p.accent },
    { tag: t.invalid, color: s.heading ?? p.accent }
  ])
  return [theme, syntaxHighlighting(highlight)]
}
