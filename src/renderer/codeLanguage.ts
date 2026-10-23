import { javascript } from '@codemirror/lang-javascript'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { linter, lintGutter } from '@codemirror/lint'
import type { Extension } from '@codemirror/state'
import { lintSource } from './codeLint'
import type { LintKind } from '../shared/lint'
import { isMarkdownFile } from './paths'

/**
 * The editor's language follows the file's extension: Markdown for notes (and
 * anything untitled), Python and JavaScript for source files, which are also
 * linted (Ruff and ESLint, see main/lint.ts). Every other text file (.txt,
 * .env, …) is plain text: no parser, so `# comment` is not a heading.
 */

export function codeKind(path: string | null): LintKind | null {
  const ext = /\.([^./\\]+)$/.exec(path ?? '')?.[1].toLowerCase()
  if (ext === 'py' || ext === 'pyw') return 'python'
  if (ext === 'js' || ext === 'mjs') return 'javascript'
  if (ext === 'cjs') return 'commonjs'
  if (ext === 'jsx') return 'jsx'
  return null
}

const lint = (kind: LintKind): Extension => [linter(lintSource(kind), { delay: 500 }), lintGutter()]

// Built once: reconfiguring with the same extension keeps the parse instead of starting over.
const LANGUAGES: Record<LintKind | 'markdown' | 'plain', Extension> = {
  // GFM base: tables, strikethrough and task lists parse (and live-preview) correctly.
  // URL-over-selection pasting is handled by linkPaste (see there).
  markdown: markdown({ base: markdownLanguage, pasteURLAsLink: false }),
  python: [python(), lint('python')],
  javascript: [javascript(), lint('javascript')],
  commonjs: [javascript(), lint('commonjs')],
  jsx: [javascript({ jsx: true }), lint('jsx')],
  plain: []
}

/** Language (and, for source files, linting) for a document at `path`. */
export function languageFor(path: string | null): Extension {
  return LANGUAGES[codeKind(path) ?? (isMarkdownFile(path) ? 'markdown' : 'plain')]
}
