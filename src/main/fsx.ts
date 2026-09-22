import { constants, promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'

let seq = 0

/**
 * Write a file so a crash mid-write cannot leave it truncated: the content
 * goes to a sibling temp file which then replaces the target in one rename.
 * A symlinked target is followed so the real file is replaced, and an
 * existing file keeps its permission bits.
 *
 * Behaves like a plain write where one would fail or is all that works: a
 * read-only target is refused up front (a rename would slip past the file's
 * own permissions on POSIX), and when the temp file cannot be created or
 * renamed (directory not writable, Windows lock held by a sync client or
 * scanner) the content is written directly.
 */
export async function writeFileAtomic(path: string, data: string | Buffer): Promise<void> {
  const target = await fs.realpath(path).catch(() => path)
  const existing = await fs.stat(target).catch(() => null)
  if (existing) await fs.access(target, constants.W_OK) // throws EACCES/EPERM, on every platform
  const tmp = join(dirname(target), `.${process.pid}-${Date.now()}-${++seq}.tmp`)
  try {
    await fs.writeFile(tmp, data, existing ? { mode: existing.mode } : {})
  } catch {
    return fs.writeFile(target, data)
  }
  try {
    await fs.rename(tmp, target)
  } catch {
    await fs.unlink(tmp).catch(() => {})
    return fs.writeFile(target, data)
  }
}
