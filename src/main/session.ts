import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from './fsx'

/**
 * Hot exit, like Sublime Text: the open tabs and any unsaved text in them are
 * written to userData/session.json, and put back on the next start. Clean
 * tabs keep only their path (the file is re-read from disk); `content` is
 * present only for tabs with edits that were never saved.
 */
export interface SessionTab {
  path: string | null
  /** Unsaved text (LF line endings); absent when the tab matches its file. */
  content?: string
  /** The file's own line ending, restored with the unsaved text. */
  eol?: '\n' | '\r\n'
  anchor: number
  head: number
}

export interface Session {
  tabs: SessionTab[]
  active: number
}

const file = (): string => join(app.getPath('userData'), 'session.json')

const isPos = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0

/** Keep only well-formed tabs: the file may be hand-edited, truncated or from another version. */
function clean(raw: unknown): Session | null {
  if (!raw || typeof raw !== 'object') return null
  const { tabs, active } = raw as { tabs?: unknown; active?: unknown }
  if (!Array.isArray(tabs)) return null
  const out: SessionTab[] = []
  for (const t of tabs as Partial<SessionTab>[]) {
    if (!t || typeof t !== 'object') continue
    const path = typeof t.path === 'string' && t.path ? t.path : null
    const content = typeof t.content === 'string' ? t.content : undefined
    if (!path && content === undefined) continue // an untitled tab with nothing in it
    out.push({
      path,
      ...(content !== undefined ? { content } : {}),
      ...(t.eol === '\r\n' ? { eol: '\r\n' as const } : {}),
      anchor: isPos(t.anchor) ? t.anchor : 0,
      head: isPos(t.head) ? t.head : 0
    })
  }
  return { tabs: out, active: isPos(active) ? Math.min(active, Math.max(0, out.length - 1)) : 0 }
}

export async function loadSession(): Promise<Session | null> {
  try {
    return clean(JSON.parse(await fs.readFile(file(), 'utf8')))
  } catch {
    return null
  }
}

// Writes go out one at a time, in order, so an older snapshot never lands last.
let writing: Promise<unknown> = Promise.resolve()

export function saveSession(raw: unknown): Promise<void> {
  const s = clean(raw) ?? { tabs: [], active: 0 }
  const write = writing.then(async () => {
    await fs.mkdir(app.getPath('userData'), { recursive: true })
    await writeFileAtomic(file(), JSON.stringify(s))
    // Unsaved notes can be sensitive: readable by the user only.
    await fs.chmod(file(), 0o600).catch(() => {})
  })
  writing = write.catch(() => {})
  return write
}
