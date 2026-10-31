import { randomBytes, timingSafeEqual } from 'node:crypto'
import { promises as fs, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

/**
 * ssh's askpass hook, answered by Tendril. Every ssh, ssh-add and terminal
 * shell Tendril starts gets SSH_ASKPASS pointing at a two-line script that
 * runs this app's own binary as Node (ELECTRON_RUN_AS_NODE) with a tiny client.
 * The client hands the prompt to a Unix socket here and prints the answer for
 * ssh to read. Nothing is written to disk but the scripts; the socket sits in
 * a per-user 0700 folder, and each request must carry the session's token.
 * Socket and scripts are named after this process (askpass-<pid>…), so two
 * Tendril windows open at once each answer their own ssh.
 */

export type PromptKind = 'confirm' | 'passphrase' | 'password' | 'other'

/** Who is asking, so the answer can come from the right `pass` entry. */
export interface AskContext {
  /** A Tendril connection to a saved host (or its key being loaded into the agent). */
  host?: { name: string }
  /** A quick `user@host` connection. */
  target?: { user: string; hostname: string }
  /** ssh run by hand in the built-in terminal: the prompt names the host. */
  terminal?: boolean
}

export type AskHandler = (ctx: AskContext, prompt: string, kind: PromptKind) => Promise<string | null>

const CLIENT = `'use strict'
const net = require('net')
const s = net.createConnection(process.env.TENDRIL_ASKPASS_SOCK)
let out = ''
s.on('connect', () => s.end(JSON.stringify({ token: process.env.TENDRIL_ASKPASS_TOKEN, ctx: process.env.TENDRIL_ASKPASS_CTX || '', prompt: process.argv.slice(2).join(' ') })))
s.on('data', (d) => (out += d))
s.on('end', () => {
  try {
    const r = JSON.parse(out)
    if (r.ok) { process.stdout.write(r.value + '\\n'); process.exit(0) }
  } catch {}
  process.exit(1)
})
s.on('error', () => process.exit(1))
`

let dir: string | null = null
let server: Server | null = null
let files: string[] = []
let token = ''
let script = ''
let handler: AskHandler = async () => null
const contexts = new Map<string, AskContext>()

/** Per-user folder for sockets (askpass, agents, control masters): short, private, on tmpfs where there is one. */
export async function runtimeDir(): Promise<string> {
  if (dir) return dir
  const uid = userInfo().uid
  const base = process.env['XDG_RUNTIME_DIR'] ? join(process.env['XDG_RUNTIME_DIR'], 'tendril') : join(process.platform === 'darwin' ? '/tmp' : tmpdir(), `tendril-${uid}`)
  await fs.mkdir(base, { recursive: true, mode: 0o700 })
  const st = await fs.lstat(base)
  // Someone else's folder (or a symlink planted in /tmp) is not ours to use.
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid) throw new Error(`Unsafe runtime folder: ${base}`)
  await fs.chmod(base, 0o700)
  dir = base
  return base
}

export function classify(prompt: string): PromptKind {
  if (/\(yes\/no|yes\/no\//i.test(prompt)) return 'confirm'
  if (/passphrase/i.test(prompt)) return 'passphrase'
  if (/password/i.test(prompt)) return 'password'
  return 'other'
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** What a Tendril that did not quit cleanly left behind; another running Tendril's stays. */
async function removeStale(base: string): Promise<void> {
  for (const name of await fs.readdir(base).catch(() => [] as string[])) {
    const pid = /^askpass-(\d+)(?:\.sock|\.js)?$/.exec(name)?.[1]
    if (pid && Number(pid) !== process.pid && !alive(Number(pid))) await fs.rm(join(base, name), { force: true })
  }
}

async function start(): Promise<void> {
  if (server) return
  const base = await runtimeDir()
  await removeStale(base)
  token = randomBytes(24).toString('hex')
  const own = `askpass-${process.pid}`
  const sock = join(base, `${own}.sock`)
  await fs.rm(sock, { force: true })
  const js = join(base, `${own}.js`)
  script = join(base, own)
  files = [sock, js, script]
  await fs.writeFile(js, CLIENT, { mode: 0o600 })
  await fs.writeFile(script, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "$TENDRIL_ASKPASS_NODE" "${js}" "$@"\n`, { mode: 0o700 })
  server = createServer({ allowHalfOpen: true }, (conn) => {
    let raw = ''
    conn.setEncoding('utf8')
    conn.on('data', (d: string) => {
      raw += d
      if (raw.length > 64 * 1024) conn.destroy()
    })
    conn.on('end', async () => {
      let reply = { ok: false, value: '' }
      try {
        const msg = JSON.parse(raw) as { token?: string; ctx?: string; prompt?: string }
        const a = Buffer.from(String(msg.token ?? ''))
        const b = Buffer.from(token)
        const ctx = contexts.get(String(msg.ctx ?? ''))
        if (a.length === b.length && timingSafeEqual(a, b) && ctx) {
          const prompt = String(msg.prompt ?? '').trim()
          const value = await handler(ctx, prompt, classify(prompt))
          if (value !== null) reply = { ok: true, value }
        }
      } catch {
        /* malformed request: no answer */
      }
      conn.end(JSON.stringify(reply))
    })
    conn.on('error', () => {})
  })
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(sock, () => resolve())
  })
  await fs.chmod(sock, 0o600)
}

export function setAskHandler(h: AskHandler): void {
  handler = h
}

/**
 * Environment for one process (or terminal) that may need a secret. `release`
 * forgets the context once that process is done.
 */
export async function askEnv(ctx: AskContext): Promise<{ env: Record<string, string>; release: () => void }> {
  await start()
  const id = randomBytes(8).toString('hex')
  contexts.set(id, ctx)
  return {
    env: {
      SSH_ASKPASS: script,
      // Always askpass, even with a terminal (OpenSSH 8.4+); older ssh still uses it when there is no terminal.
      SSH_ASKPASS_REQUIRE: 'force',
      TENDRIL_ASKPASS_NODE: process.execPath,
      TENDRIL_ASKPASS_SOCK: files[0],
      TENDRIL_ASKPASS_TOKEN: token,
      TENDRIL_ASKPASS_CTX: id
    },
    release: () => contexts.delete(id)
  }
}

/** Tendril quits: its socket and scripts go (synchronously, before the process is gone). */
export function stopAskpass(): void {
  server?.close()
  server = null
  contexts.clear()
  for (const f of files) rmSync(f, { force: true })
  files = []
}
