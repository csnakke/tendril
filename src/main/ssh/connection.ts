import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { app } from 'electron'
import type { RemoteEntry, SshForward, SshHost } from '../../shared/ssh'
import { Agent } from './agent'
import { askEnv, runtimeDir, type AskContext } from './askpass'
import { passGet } from './pass'

/**
 * One SSH connection, made with the system's OpenSSH as a control master:
 * every listing, transfer, port forward and terminal session afterwards rides
 * the same authenticated connection through its control socket, with no new
 * login. A saved host gets its own private agent holding its key from `pass`.
 */

export type Target = { host: SshHost } | { quick: { user: string; hostname: string; port: number } }

/** Single-quoted for a POSIX shell. */
export const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

const knownHosts = (): string => join(app.getPath('userData'), 'ssh', 'known_hosts')

/**
 * Ends `pids` once this app's process is gone, however it went (a crash, a
 * kill, a logout): the control master and the agent holding the key must not
 * outlive Tendril. A shell loop checking every two seconds costs nothing.
 */
function watchdog(pids: (number | undefined)[]): ChildProcess {
  const ids = pids.filter((p): p is number => !!p).map(String)
  const w = spawn('sh', ['-c', 'while kill -0 "$1" 2>/dev/null; do sleep 2; done; shift; kill "$@" 2>/dev/null', 'tendril-watchdog', String(process.pid), ...ids], { stdio: 'ignore', detached: true })
  w.unref()
  return w
}

/** ssh's last words, without the chatter. */
function reason(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^Warning: Permanently added|^Connection to .* closed|^Shared connection to/.test(l))
    // A forward that could not start was reported when it happened; it is not why the connection ended.
    .filter((l) => !/^bind \[|channel_setup_fwd|mux_master_process|cannot listen to port|Address already in use|requested (dynamic|local|remote) forward/.test(l))
  return lines.slice(-3).join('\n') || 'The connection failed.'
}

function run(cmd: string, args: string[], opts: { input?: string; env?: Record<string, string>; timeout?: number } = {}): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...opts.env }, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    const out: Buffer[] = []
    let stderr = ''
    const timer = opts.timeout ? setTimeout(() => child.kill(), opts.timeout) : null
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
    child.on('error', () => resolve({ code: -1, stdout: Buffer.alloc(0), stderr: `${cmd} is not installed` }))
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(opts.input ?? '')
  })
}

// Remote files (Connection.readFile / writeFile). stat differs between GNU,
// BusyBox and BSD/macOS, so each is tried; wc -c pads its number on macOS.
const STAMP = `stamp() { m=$(stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0); n=$(wc -c < "$1" | tr -d ' '); echo "$m:$n"; }`

const READ_FILE = `${STAMP}
f=$1; max=$2
[ -e "$f" ] || exit 4
[ -d "$f" ] && exit 5
[ -f "$f" ] || exit 6
[ -r "$f" ] || exit 7
s=$(stamp "$f"); n=\${s#*:}; m=\${s%%:*}
w=0; [ -w "$f" ] && w=1
echo "$n $m $w"
[ "$n" -gt "$max" ] && exit 0
cat -- "$f"
`

const WRITE_FILE = `${STAMP}
f=$1; expect=$2
if [ -L "$f" ]; then r=$(readlink -f -- "$f" 2>/dev/null) && [ -n "$r" ] && f=$r; fi
if [ -e "$f" ]; then
  [ -d "$f" ] && exit 5
  if [ "$expect" = "?" ]; then echo; exit 9; fi
  if [ -n "$expect" ] && [ "$(stamp "$f")" != "$expect" ]; then exit 9; fi
  [ -w "$f" ] || exit 8
fi
d=$(dirname -- "$f"); b=$(basename -- "$f")
t=
if [ ! -e "$f" ] || [ -O "$f" ]; then t=$(mktemp "$d/.$b.tendril.XXXXXX" 2>/dev/null) || t=; fi
if [ -n "$t" ]; then
  if ! cat > "$t"; then rm -f -- "$t"; exit 10; fi
  if [ -e "$f" ]; then
    mode=$(stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f" 2>/dev/null) && chmod "$mode" "$t"
  else
    chmod 644 "$t"
  fi
  if ! mv -f -- "$t" "$f"; then rm -f -- "$t"; exit 10; fi
else
  cat > "$f" || exit 10
fi
stamp "$f"
`

/** What the remote file scripts' exit codes mean. */
const FILE_ERRORS: Record<number, string> = {
  4: 'The file does not exist on the server; it may have been moved or deleted.',
  5: 'It is a folder, not a file.',
  6: 'It is not a regular file.',
  7: 'You do not have permission to read it on the server.',
  8: 'You do not have permission to write it on the server (it is read-only there).',
  10: 'The server could not write the file (disk full, or the folder is read-only?).'
}

export class Connection {
  readonly label: string
  readonly hostId: string | null
  home = '/'
  /** The server has no rsync: transfers use sftp. */
  noRemoteRsync = false
  readonly forwards = new Map<string, { on: boolean; error?: string }>()
  private ctl = ''
  private master: ChildProcess | null = null
  private agent: Agent | null = null
  private closing = false
  private guard: ChildProcess | null = null
  /** Authenticated; losing the master after this is a dropped connection, not a failed login. */
  private ready = false

  constructor(
    readonly target: Target,
    private readonly onLost: (why: string) => void
  ) {
    this.label = 'host' in target ? target.host.name : `${target.quick.user}@${target.quick.hostname}`
    this.hostId = 'host' in target ? target.host.id : null
  }

  get user(): string {
    return 'host' in this.target ? this.target.host.user : this.target.quick.user
  }
  get hostname(): string {
    return 'host' in this.target ? this.target.host.hostname : this.target.quick.hostname
  }
  get port(): number {
    return 'host' in this.target ? this.target.host.port : this.target.quick.port
  }
  get saved(): SshHost | null {
    return 'host' in this.target ? this.target.host : null
  }
  /** user@host as rsync and sftp spell it (IPv6 in brackets). */
  get userHost(): string {
    return `${this.user}@${this.hostname.includes(':') ? `[${this.hostname}]` : this.hostname}`
  }
  askContext(): AskContext {
    return 'host' in this.target ? { host: { name: this.target.host.name } } : { target: { user: this.user, hostname: this.hostname } }
  }

  /** Options every ssh of this connection gets. Saved hosts ignore ~/.ssh/config: Settings is their config. */
  private base(): string[] {
    return [
      ...(this.saved ? ['-F', 'none', '-o', `IdentityAgent=${this.agent?.sock ?? 'none'}`] : []),
      '-p', String(this.port),
      '-l', this.user,
      '-o', `ControlPath=${this.ctl}`,
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=4',
      '-o', 'ConnectTimeout=15',
      // New hosts are confirmed (askpass shows the fingerprint) and remembered in Tendril's own file.
      '-o', `UserKnownHostsFile="${knownHosts()}" ~/.ssh/known_hosts`,
      '-o', 'StrictHostKeyChecking=ask'
    ]
  }

  /** Options for a command that rides the open connection and must never prompt. */
  clientArgs(): string[] {
    return [...this.base(), '-o', 'ControlMaster=no', '-o', 'BatchMode=yes']
  }

  async open(): Promise<void> {
    await fs.mkdir(dirname(knownHosts()), { recursive: true, mode: 0o700 })
    this.ctl = join(await runtimeDir(), `c-${randomBytes(6).toString('hex')}`)
    const host = this.saved
    if (host) {
      this.agent = await Agent.start()
      try {
        if (host.hasKey) {
          const key = await passGet(`tendril/ssh/${host.name}/key`)
          if (!key) throw new Error(`The key for ${host.name} could not be read from pass.`)
          const ask = await askEnv({ host: { name: host.name } })
          try {
            await this.agent.addKey(key, ask.env)
          } finally {
            ask.release()
          }
        }
      } catch (err) {
        this.agent.stop()
        this.agent = null
        throw err
      }
    }
    const ask = await askEnv(this.askContext())
    let stderr = ''
    const master = spawn('ssh', [...this.base(), '-M', '-N', '-o', 'ControlMaster=yes', '-o', 'ControlPersist=no', '-o', 'ExitOnForwardFailure=no', this.hostname], {
      env: { ...process.env, ...ask.env },
      stdio: ['ignore', 'ignore', 'pipe'],
      // No controlling terminal: ssh asks through askpass only.
      detached: true
    })
    this.master = master
    this.guard = watchdog([master.pid, this.agent?.pid])
    master.stderr!.on('data', (d: Buffer) => (stderr = (stderr + d.toString('utf8')).slice(-8192)))
    let exited = false
    master.on('error', () => (stderr = 'ssh is not installed'))
    master.on('exit', () => {
      exited = true
      ask.release()
      // Without its master the connection is over: the agent (holding the key) goes with it.
      this.agent?.stop()
      this.agent = null
      this.guard?.kill()
      if (!this.closing && this.ready) this.onLost(reason(stderr))
    })
    try {
      // Up once the control socket answers; a login prompt can take as long as the person needs.
      while (!(await this.alive())) {
        if (exited) throw new Error(reason(stderr))
        await new Promise((r) => setTimeout(r, 250))
      }
      this.ready = true
      ask.release()
      this.home = (await this.exec('cd && pwd')).toString('utf8').trim() || '/'
    } catch (err) {
      this.close()
      throw err
    }
  }

  alive(): Promise<boolean> {
    return run('ssh', [...this.base(), '-O', 'check', this.hostname], { timeout: 5000 }).then((r) => r.code === 0)
  }

  /** Run a POSIX sh script on the server (sent on stdin, so the login shell's syntax never matters). */
  async exec(script: string, timeout = 60_000): Promise<Buffer> {
    const r = await run('ssh', [...this.clientArgs(), this.hostname, 'sh -s'], { input: script, timeout })
    if (r.code !== 0) {
      const err = new Error(reason(r.stderr)) as Error & { code?: number }
      err.code = r.code
      throw err
    }
    return r.stdout
  }

  async list(dir: string): Promise<RemoteEntry[]> {
    // GNU find (Linux servers) gives types, sizes and times; elsewhere plain ls gives names and folders.
    const script = `cd -- ${shq(dir)} || exit 3
if find . -maxdepth 0 -printf '' >/dev/null 2>&1; then
  printf 'F\\n'; LC_ALL=C find . -mindepth 1 -maxdepth 1 -printf '%y\\t%Y\\t%s\\t%T@\\t%P\\0'
else
  printf 'L\\n'; LC_ALL=C ls -1Ap
fi
`
    let out: Buffer
    try {
      out = await this.exec(script)
    } catch (err) {
      if ((err as { code?: number }).code === 3) throw new Error(`Cannot open ${dir}`)
      throw err
    }
    const text = out.toString('utf8')
    const nl = text.indexOf('\n')
    const kind = text.slice(0, nl)
    const body = text.slice(nl + 1)
    const entries: RemoteEntry[] = []
    if (kind === 'F') {
      for (const rec of body.split('\0')) {
        if (!rec) continue
        const [y, Y, size, mtime, ...rest] = rec.split('\t')
        const name = rest.join('\t')
        entries.push({ name, path: posix.join(dir, name), isDir: Y === 'd', isLink: y === 'l', size: Number(size) || 0, mtime: Math.floor(Number(mtime) || 0) })
      }
    } else {
      for (const line of body.split('\n')) {
        if (!line) continue
        const isDir = line.endsWith('/')
        const name = isDir ? line.slice(0, -1) : line
        entries.push({ name, path: posix.join(dir, name), isDir, isLink: false, size: 0, mtime: 0 })
      }
    }
    return entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
  }

  /**
   * Run a POSIX sh script on the server with arguments, `input` on its standard
   * input (exec sends the script itself that way). The script is kept free of
   * backslashes, so any login shell passes it to sh unchanged.
   */
  private script(script: string, args: string[], input = '', timeout = 120_000): ReturnType<typeof run> {
    return run('ssh', [...this.clientArgs(), this.hostname, ['sh', '-c', script, 'sh', ...args].map(shq).join(' ')], { input, timeout })
  }

  /**
   * A file's bytes for the editor, with its stamp (modification time and size,
   * to notice a change on the server before saving over it) and whether it can
   * be written. Nothing is sent when it is larger than `max` bytes.
   */
  async readFile(path: string, max: number): Promise<{ data: Buffer; size: number; stamp: string; writable: boolean }> {
    const r = await this.script(READ_FILE, [path, String(max)])
    if (r.code !== 0) throw new Error(FILE_ERRORS[r.code] ?? reason(r.stderr))
    const nl = r.stdout.indexOf(10)
    const [size, mtime, writable] = r.stdout.subarray(0, nl).toString('utf8').trim().split(/\s+/)
    return { data: r.stdout.subarray(nl + 1), size: Number(size) || 0, stamp: `${mtime}:${Number(size) || 0}`, writable: writable === '1' }
  }

  /**
   * Save `content` to `path`. `expect` is the stamp it had when read: when the
   * file has changed since (or `expect` is '?', not known), nothing is written
   * and the result says so; '' writes regardless. A file is replaced through a
   * temporary file next to it and a rename, so a broken connection never leaves
   * half of it; one not owned by you (or in a folder you cannot write) is
   * written in place, which keeps its owner. Mode and symlinks are kept.
   */
  async writeFile(path: string, content: string, expect: string): Promise<{ stamp: string } | { conflict: true }> {
    const r = await this.script(WRITE_FILE, [path, expect], content)
    if (r.code === 9) return { conflict: true }
    if (r.code !== 0) throw new Error(FILE_ERRORS[r.code] ?? reason(r.stderr))
    return { stamp: r.stdout.toString('utf8').trim() }
  }

  /** Start or stop one port forward on the open connection. */
  async forward(f: SshForward, on: boolean): Promise<void> {
    const bind = f.lan ? '0.0.0.0' : '127.0.0.1'
    const to = `${f.host.includes(':') ? `[${f.host}]` : f.host}:${f.port}`
    const spec = f.type === 'D' ? ['-D', `${bind}:${f.bindPort}`] : [`-${f.type}`, `${bind}:${f.bindPort}:${to}`]
    const r = await run('ssh', [...this.base(), '-O', on ? 'forward' : 'cancel', ...spec, this.hostname], { timeout: 15_000 })
    if (r.code !== 0) {
      this.forwards.set(f.id, { on: false, error: reason(r.stderr) })
      throw new Error(reason(r.stderr))
    }
    this.forwards.set(f.id, { on })
  }

  /**
   * The `ssh` command line that opens a shell on this connection (for the
   * built-in terminal). With a marker, sudo there prompts with it
   * (SUDO_PROMPT), so Tendril can recognise its real prompts; a server that
   * forces its own prompt simply shows that instead.
   */
  shellArgs(marker: string | null = null): string[] {
    const remote = marker ? [`exec env SUDO_PROMPT='[sudo:${marker}] password for %p: ' "$SHELL" -l`] : []
    return ['ssh', ...this.base(), '-o', 'ControlMaster=no', ...(marker ? ['-t'] : []), this.hostname, ...remote]
  }

  /** The same, as one line for a shell to run. */
  shellCommand(marker: string | null = null): string {
    return this.shellArgs(marker).map(shq).join(' ')
  }

  /** rsync's -e: ssh over the open connection. rsync splits this on spaces and honours quotes. */
  rsyncShell(): string {
    return ['ssh', ...this.clientArgs()].map((a) => (/[\s"']/.test(a) ? `'${a}'` : a)).join(' ')
  }

  sftpArgs(): string[] {
    // sftp spells the port -P; everything else passes through as ssh options.
    const args = this.clientArgs()
    const i = args.indexOf('-p')
    args.splice(i, 2, '-P', String(this.port))
    const l = args.indexOf('-l')
    args.splice(l, 2)
    return args
  }

  close(): void {
    this.closing = true
    if (this.ctl) void run('ssh', [...this.base(), '-O', 'exit', this.hostname], { timeout: 3000 })
    this.master?.kill()
    this.agent?.stop()
    this.guard?.kill()
    if (this.ctl) void fs.rm(this.ctl, { force: true })
  }
}
