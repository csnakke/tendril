/** Which linter a source file goes to (and, for ESLint, how it is parsed). */
export type LintKind = 'python' | 'javascript' | 'jsx' | 'commonjs'

/**
 * One finding, as the main process hands it to the editor. Positions are
 * offsets into the text that was linted (UTF-16 code units, LF line breaks),
 * which is the editor's own document.
 */
export interface LintMessage {
  from: number
  to: number
  severity: 'error' | 'warning'
  /** "ruff (F401)", "eslint (no-undef)", or the tool alone for a syntax error. */
  source: string
  message: string
  fix?: { label: string; edits: { from: number; to: number; insert: string }[] }
}
