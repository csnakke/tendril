import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { runtimeDir } from './askpass'

/**
 * A private ssh-agent (the system's own OpenSSH one) for one connection.
 * Keys saved in `pass` are fed to it through `ssh-add -` on a pipe, so they
 * are never written to disk in the clear; only that connection's ssh uses it
 * (IdentityAgent), and stopping it forgets the key.
 */
export class Agent {
  private constructor(
    readonly sock: string,
    private readonly proc: ChildProcess
  ) {}

  static async start(): Promise<Agent> {
    const sock = join(await runtimeDir(), `a-${randomBytes(6).toString('hex')}`)
    const proc = spawn('ssh-agent', ['-D', '-a', sock], { stdio: 'ignore' })
    const failed = new Promise<never>((_, reject) => {
      proc.once('error', () => reject(new Error('ssh-agent is not installed')))
      proc.once('exit', () => reject(new Error('ssh-agent stopped before it was ready')))
    })
    const ready = (async (): Promise<void> => {
      for (let i = 0; i < 100; i++) {
        if (await fs.access(sock).then(() => true, () => false)) return
        await new Promise((r) => setTimeout(r, 30))
      }
      throw new Error('ssh-agent did not start')
    })()
    try {
      await Promise.race([ready, failed])
    } catch (err) {
      proc.kill()
      throw err
    }
    failed.catch(() => {})
    return new Agent(sock, proc)
  }

  get pid(): number | undefined {
    return this.proc.pid
  }

  /** Load a private key (its text, from `pass`). A passphrase is asked for through askpass (`env`). */
  addKey(key: string, env: Record<string, string>): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('ssh-add', ['-q', '-'], {
        env: { ...process.env, ...env, SSH_AUTH_SOCK: this.sock },
        stdio: ['pipe', 'ignore', 'pipe'],
        // No controlling terminal: ssh-add then asks through askpass, never a tty.
        detached: true
      })
      let err = ''
      child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')))
      child.on('error', () => reject(new Error('ssh-add is not installed')))
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || 'The saved key could not be loaded (wrong passphrase?)'))))
      child.stdin.end(key.endsWith('\n') ? key : key + '\n')
    })
  }

  stop(): void {
    this.proc.kill()
    void fs.rm(this.sock, { force: true })
  }
}
