import { spawn, type ChildProcess } from 'node:child_process'
import { basename } from 'node:path'
import type { Transfer } from '../../shared/ssh'
import type { Connection } from './connection'

/**
 * Uploads and downloads over the open connection, two at a time.
 *
 * rsync does the work: partial files are kept in `.tendril-partial` and an
 * interrupted transfer continues from them, every file is checksummed, and
 * there is no limit on size or count. A dropped connection is retried with
 * growing pauses, reconnecting first. A server without rsync gets sftp
 * (`put/get -a` resumes too, but reports no progress).
 */

interface Job extends Transfer {
  /** Local path (up) or remote path (down). */
  src: string
  proc: ChildProcess | null
  conn: Connection
  timer: ReturnType<typeof setTimeout> | null
}

const MAX_RUNNING = 2
const RETRY_DELAYS = [2, 5, 10, 20, 30, 60]
/** rsync exits that mean the link (not the files) failed: retry. */
const RSYNC_RETRY = new Set([5, 10, 12, 30, 35, 255])

let rsyncPath: Promise<string | null> | null = null

/** A full rsync, 3.1 or newer (progress, resume). macOS's own openrsync does not qualify; Homebrew's does. */
function findRsync(): Promise<string | null> {
  rsyncPath ??= (async () => {
    const candidates = process.platform === 'darwin' ? ['/opt/homebrew/bin/rsync', '/usr/local/bin/rsync', 'rsync'] : ['rsync']
    for (const c of candidates) {
      const v = await new Promise<string>((resolve) => {
        const p = spawn(c, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] })
        let out = ''
        p.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')))
        p.on('error', () => resolve(''))
        p.on('close', () => resolve(out.split('\n')[0] ?? ''))
      })
      const m = v.match(/^rsync\s+version\s+v?(\d+)\.(\d+)/)
      if (m && !/openrsync/i.test(v) && (Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 1))) return c
    }
    return null
  })()
  return rsyncPath
}

/** sftp's batch quoting: double quotes, with " and \ escaped. */
const sftpq = (s: string): string => `"${s.replace(/[\\"]/g, '\\$&')}"`

export class Transfers {
  private jobs: Job[] = []
  private seq = 0
  private notifyQueued = false

  constructor(
    private readonly notify: (list: Transfer[]) => void,
    /** The live connection for a job's host, reconnecting if it dropped; null when that is not possible. */
    private readonly reconnect: (conn: Connection) => Promise<Connection | null>
  ) {}

  list(): Transfer[] {
    return this.jobs.map(({ src: _src, proc: _proc, conn: _conn, timer: _timer, ...t }) => t)
  }

  private changed(): void {
    if (this.notifyQueued) return
    this.notifyQueued = true
    setTimeout(() => {
      this.notifyQueued = false
      this.notify(this.list())
    }, 200)
  }

  add(conn: Connection, direction: 'up' | 'down', src: string, dest: string): void {
    const clean = src.length > 1 ? src.replace(/\/+$/, '') : src
    this.jobs.push({
      id: ++this.seq,
      direction,
      name: basename(clean) || clean,
      src: clean,
      dest,
      host: conn.label,
      state: 'queued',
      percent: 0,
      bytes: 0,
      speed: '',
      eta: '',
      attempt: 0,
      engine: 'rsync',
      proc: null,
      conn,
      timer: null
    })
    this.changed()
    this.pump()
  }

  stop(id: number): void {
    const job = this.jobs.find((j) => j.id === id)
    if (!job || !['queued', 'running', 'retrying'].includes(job.state)) return
    if (job.timer) clearTimeout(job.timer)
    job.timer = null
    job.state = 'stopped'
    job.message = 'Stopped; Resume continues where it left off.'
    job.proc?.kill()
    this.changed()
    this.pump()
  }

  resume(id: number): void {
    const job = this.jobs.find((j) => j.id === id)
    if (!job || !['stopped', 'failed'].includes(job.state)) return
    job.state = 'queued'
    job.attempt = 0
    job.message = undefined
    this.changed()
    this.pump()
  }

  clear(): void {
    this.jobs = this.jobs.filter((j) => !['done', 'failed', 'stopped'].includes(j.state))
    this.changed()
  }

  /** Stop everything (quitting). Partial files stay for next time. */
  stopAll(): void {
    for (const j of this.jobs) this.stop(j.id)
  }

  get active(): number {
    return this.jobs.filter((j) => ['queued', 'running', 'retrying'].includes(j.state)).length
  }

  private pump(): void {
    const running = this.jobs.filter((j) => j.state === 'running').length
    for (const job of this.jobs.filter((j) => j.state === 'queued').slice(0, Math.max(0, MAX_RUNNING - running))) void this.run(job)
  }

  private async run(job: Job): Promise<void> {
    job.state = 'running'
    job.attempt++
    job.message = undefined
    this.changed()
    const conn = await this.reconnect(job.conn)
    if (!conn) return this.finish(job, 'failed', `Not connected to ${job.host}.`)
    job.conn = conn
    const rsync = conn.noRemoteRsync ? null : await findRsync()
    job.engine = rsync ? 'rsync' : 'sftp'
    const { code, stderr } = rsync ? await this.rsync(job, rsync) : await this.sftp(job)
    if ((job.state as string) === 'stopped') return
    if (code === 0 || (rsync && code === 24)) return this.finish(job, 'done', code === 24 ? 'Done; some source files vanished while copying.' : undefined)
    // A server without rsync: switch this connection to sftp and go again at once.
    if (rsync && /rsync:? (command )?not found|command not found.*rsync|rsync: No such file/i.test(stderr)) {
      conn.noRemoteRsync = true
      job.attempt--
      return this.run(job)
    }
    const why = stderr.split('\n').map((l) => l.trim()).filter(Boolean).slice(-2).join(' ')
    const retryable = rsync ? RSYNC_RETRY.has(code) : code === 255 || code === -1
    if (retryable && job.attempt <= RETRY_DELAYS.length) {
      const wait = RETRY_DELAYS[job.attempt - 1]
      job.state = 'retrying'
      job.message = `Connection problem; retrying in ${wait}s (attempt ${job.attempt + 1}). ${why}`
      this.changed()
      job.timer = setTimeout(() => {
        job.timer = null
        if (job.state === 'retrying') {
          job.state = 'queued'
          this.pump()
        }
      }, wait * 1000)
      return
    }
    this.finish(job, 'failed', why || `${job.engine} exited with code ${code}.`)
  }

  private finish(job: Job, state: 'done' | 'failed', message?: string): void {
    job.state = state
    job.proc = null
    job.message = message
    if (state === 'done') job.percent = job.engine === 'rsync' ? 100 : job.percent
    this.changed()
    this.pump()
  }

  private spawnJob(job: Job, cmd: string, args: string[], input: string | null, onOut: (text: string) => void): Promise<{ code: number; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(cmd, args, { env: { ...process.env, LC_ALL: 'C' }, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'], detached: true })
      job.proc = child
      let stderr = ''
      child.stdout!.on('data', (d: Buffer) => onOut(d.toString('utf8')))
      child.stderr!.on('data', (d: Buffer) => (stderr = (stderr + d.toString('utf8')).slice(-4096)))
      child.on('error', () => resolve({ code: -1, stderr: `${cmd} is not installed` }))
      child.on('close', (code) => resolve({ code: code ?? -1, stderr }))
      if (input !== null) child.stdin!.end(input)
    })
  }

  private rsync(job: Job, rsync: string): Promise<{ code: number; stderr: string }> {
    const remote = (p: string): string => `${job.conn.userHost}:${p}`
    const args = [
      '-a',
      // Paths go to the server as they are, never through its shell.
      '--protect-args',
      '--partial-dir=.tendril-partial',
      '--info=progress2',
      '--no-inc-recursive',
      '--timeout=120',
      '-e', job.conn.rsyncShell(),
      job.direction === 'up' ? job.src : remote(job.src),
      job.direction === 'up' ? remote(job.dest.replace(/\/*$/, '/')) : job.dest.replace(/\/*$/, '/')
    ]
    let buf = ''
    return this.spawnJob(job, rsync, args, null, (text) => {
      buf = (buf + text).slice(-2048)
      // progress2: "  1,234,567  41%   112.45MB/s    0:00:43 (xfr#3, to-chk=7/20)"
      const lines = buf.split(/[\r\n]+/)
      for (let i = lines.length - 1; i >= 0; i--) {
        const m = lines[i].match(/^\s*([\d,]+)\s+(\d+)%\s+(\S+\/s)\s+(\d+:\d{2}:\d{2})/)
        if (!m) continue
        job.bytes = Number(m[1].replace(/,/g, ''))
        job.percent = Number(m[2])
        job.speed = m[3]
        job.eta = m[4]
        this.changed()
        break
      }
    })
  }

  private sftp(job: Job): Promise<{ code: number; stderr: string }> {
    job.percent = null
    const target = (dir: string): string => `${dir.replace(/\/+$/, '')}/${job.name}`
    const batch =
      job.direction === 'up'
        ? `put -a -r ${sftpq(job.src)} ${sftpq(target(job.dest))}\n`
        : `get -a -r ${sftpq(job.src)} ${sftpq(target(job.dest))}\n`
    return this.spawnJob(job, 'sftp', ['-b', '-', ...job.conn.sftpArgs(), job.conn.userHost], batch, () => {})
  }
}
