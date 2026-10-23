import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { Diagnostic } from '@codemirror/lint'
import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { LintKind } from '../shared/lint'

/**
 * Editor side of linting source files. ESLint and Ruff run in the main
 * process (main/lint.ts); this turns their findings into diagnostics, with a
 * Fix action where the tool offers one. Should the linter be unavailable,
 * the parser's own syntax errors are shown instead.
 */

/** A diagnostic must cover something to be seen: an empty range takes the next character. */
function widen(state: EditorState, from: number, to: number): { from: number; to: number } {
  const len = state.doc.length
  from = Math.min(Math.max(from, 0), len)
  to = Math.min(Math.max(to, from), len)
  return to > from ? { from, to } : { from, to: Math.min(from + 1, state.doc.lineAt(from).to) }
}

/**
 * Syntax errors as the parser recovered from them, one per line: a single
 * typo often leaves several error nodes behind it.
 */
export function syntaxErrors(state: EditorState): Diagnostic[] {
  const tree = ensureSyntaxTree(state, state.doc.length, 1000) ?? syntaxTree(state)
  const out: Diagnostic[] = []
  let lastLine = -1
  tree.iterate({
    enter: (node) => {
      if (!node.type.isError) return
      const line = state.doc.lineAt(node.from)
      if (line.number === lastLine) return false
      lastLine = line.number
      const { from, to } = widen(state, node.from, node.to)
      const found = state.sliceDoc(from, to).trim()
      out.push({
        from,
        to,
        severity: 'error',
        source: 'syntax',
        message: found ? `Syntax error: unexpected "${found.length > 30 ? found.slice(0, 30) + '…' : found}"` : 'Syntax error: something is missing here'
      })
      return false
    }
  })
  return out
}

let warned = false

/** Lint source for a kind of file: the tool's findings, or syntax errors when it cannot run. */
export function lintSource(kind: LintKind): (view: EditorView) => Promise<Diagnostic[]> {
  return async (view) => {
    const state = view.state
    try {
      // Results for a document that has since changed are dropped by @codemirror/lint itself.
      const found = await window.api.lint(kind, state.doc.toString())
      return found.map((m) => ({
        ...widen(state, m.from, m.to),
        severity: m.severity,
        source: m.source,
        message: m.message,
        actions: m.fix
          ? [{ name: m.fix.label, apply: (v: EditorView) => v.dispatch({ changes: m.fix!.edits, scrollIntoView: true, userEvent: 'input.lint' }) }]
          : undefined
      }))
    } catch (err) {
      if (!warned) {
        warned = true
        console.warn('Linter unavailable; showing syntax errors only.', err)
      }
      return syntaxErrors(state)
    }
  }
}
