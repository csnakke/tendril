import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Linter } from 'eslint-linter-browserify'
import type { Workspace } from '@astral-sh/ruff-wasm-web'
import type { LintKind, LintMessage } from '../shared/lint'

/**
 * Linting for the editor's source files: ESLint (its recommended rules) for
 * JavaScript, Ruff (the rules `ruff check` runs by default) for Python. Both
 * run in-process — ESLint as plain JS, Ruff as WebAssembly — so nothing has
 * to be installed and no program is spawned. They live here rather than in
 * the renderer because ESLint compiles its rule schemas with `new Function`,
 * which the window's CSP rightly refuses. Each is loaded on first use.
 */

/** Offsets of each line's start; the editor sends LF-only text. */
function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1)
  return starts
}

/** Offset of a 1-based line and 1-based column, clamped into the text. */
function offset(starts: number[], textLength: number, line: number, column: number): number {
  const l = Math.min(Math.max(line, 1), starts.length) - 1
  const lineEnd = l + 1 < starts.length ? starts[l + 1] - 1 : textLength
  return Math.min(starts[l] + Math.max(column - 1, 0), lineEnd)
}

// ---- ESLint -----------------------------------------------------------------------

let eslint: Promise<{ linter: Linter; configs: Record<Exclude<LintKind, 'python'>, Linter.Config[]> }> | null = null

function loadEslint(): NonNullable<typeof eslint> {
  eslint ??= Promise.all([import('eslint-linter-browserify'), import('@eslint/js'), import('globals')]).then(([{ Linter }, js, { default: globals }]) => {
    const config = (sourceType: 'module' | 'commonjs', jsx: boolean): Linter.Config[] => [
      js.default.configs.recommended,
      {
        languageOptions: {
          ecmaVersion: 'latest',
          sourceType,
          // A .js file may be a page script or a Node one: both sets of globals are known.
          globals: { ...globals.browser, ...globals.node },
          parserOptions: { ecmaFeatures: { jsx } }
        }
      }
    ]
    return {
      linter: new Linter({ configType: 'flat' }),
      configs: { javascript: config('module', false), jsx: config('module', true), commonjs: config('commonjs', false) }
    }
  })
  return eslint
}

async function runEslint(text: string, kind: Exclude<LintKind, 'python'>): Promise<LintMessage[]> {
  const { linter, configs } = await loadEslint()
  const starts = lineStarts(text)
  return linter.verify(text, configs[kind]).map((m: Linter.LintMessage) => {
    const from = offset(starts, text.length, m.line, m.column)
    const to = m.endLine != null && m.endColumn != null ? offset(starts, text.length, m.endLine, m.endColumn) : from
    return {
      from,
      to,
      // No rule id: the file did not parse.
      severity: m.fatal || !m.ruleId ? 'error' : 'warning',
      source: m.ruleId ? `eslint (${m.ruleId})` : 'eslint',
      message: m.message,
      // `fix.range` is already in offsets of the linted text.
      ...(m.fix ? { fix: { label: 'Fix', edits: [{ from: m.fix.range[0], to: m.fix.range[1], insert: m.fix.text }] } } : {})
    }
  })
}

// ---- Ruff ----------------------------------------------------------------------------

interface RuffLocation {
  row: number
  column: number
}
interface RuffDiagnostic {
  code: string | null
  message: string
  start_location: RuffLocation
  end_location: RuffLocation
  fix: { message: string | null; edits: { content: string | null; location: RuffLocation; end_location: RuffLocation }[] } | null
}

let ruff: Promise<Workspace> | null = null

function loadRuff(): Promise<Workspace> {
  ruff ??= import('@astral-sh/ruff-wasm-web').then((m) => {
    // The web build fetches its .wasm by URL; here it is read from the package instead.
    m.initSync({ module: readFileSync(join(dirname(require.resolve('@astral-sh/ruff-wasm-web/package.json')), 'ruff_wasm_bg.wasm')) })
    // What `ruff check` selects when a project configures nothing (pyflakes and
    // the pycodestyle errors that aren't about style). Unset options keep Ruff's
    // defaults. UTF-16 columns are what the editor counts in.
    return new m.Workspace({ lint: { select: ['E4', 'E7', 'E9', 'F'] } }, m.PositionEncoding.Utf16)
  })
  return ruff
}

async function runRuff(text: string): Promise<LintMessage[]> {
  const workspace = await loadRuff()
  const starts = lineStarts(text)
  const at = (l: RuffLocation): number => offset(starts, text.length, l.row, l.column)
  return (workspace.check(text) as RuffDiagnostic[]).map((d) => {
    const syntax = !d.code || d.code === 'invalid-syntax'
    const edits = d.fix?.edits.map((e) => ({ from: at(e.location), to: at(e.end_location), insert: e.content ?? '' })) ?? []
    return {
      from: at(d.start_location),
      to: at(d.end_location),
      severity: syntax ? 'error' : 'warning',
      source: syntax ? 'ruff' : `ruff (${d.code})`,
      message: d.message,
      ...(edits.length ? { fix: { label: d.fix?.message || 'Fix', edits } } : {})
    }
  })
}

/** Findings for `text`; rejects when the linter cannot be loaded (the editor then shows syntax errors only). */
export function lint(kind: LintKind, text: string): Promise<LintMessage[]> {
  return kind === 'python' ? runRuff(text) : runEslint(text, kind)
}
