import type { IPty } from 'node-pty'
import { passGetSecret } from './pass'
import { sudoEntry, sudoSecretFor } from './remote'
import { hostOfMarker, LOCAL, sudoVersion, terminalHost } from './sudoState'

/**
 * Pastes sudo passwords (saved in Tendril's store) into a terminal.
 *
 * Automatically, for generic prompts:
 * - local sudo: sudo's exact prompt *and* the terminal's foreground process
 *   really is sudo, with this machine's sudo password;
 * - sudo in an SSH shell Tendril opened for a saved host whose Auto-Paste
 *   Guard is on: the prompt must carry that session's secret marker
 *   (SUDO_PROMPT, see Connection.shellCommand), so text that only looks like
 *   a prompt, or another server reached from there, never gets it.
 * Once a pasted password is rejected, that password is not pasted again in
 * this terminal until it is changed in Settings (its version moves).
 *
 * By hand (Ctrl+Alt+P), for any prompt: the current saved password, always.
 */

const LOCAL_PROMPT = /(?:\[sudo\] password for [^\s:]+|\[sudo: authenticate\] Password):\s*$/
/** The marker prompt as sudo prints it: %p expanded to a real user name (not the echoed command). */
const MARKED_PROMPT = /\[sudo:([0-9a-f]{24})\] password for [^\s%:]+: *$/
const REJECTED = /Sorry, try again|incorrect password|Authentication failure/i

export class SudoFill {
  private tail = ''
  private busy = false
  /** The last automatic paste, to tell whether sudo turned it down. */
  private last: { key: string; at: number } | null = null
  /** Passwords turned down here, with the version they had: not pasted again until changed. */
  private readonly rejected = new Map<string, number>()

  constructor(
    private readonly pty: IPty,
    private readonly terminal: number
  ) {}

  feed(data: string): void {
    if (this.last && Date.now() - this.last.at < 10_000 && REJECTED.test(data)) {
      this.rejected.set(this.last.key, sudoVersion(this.last.key))
      this.last = null
      this.tail = ''
      return
    }
    this.tail = (this.tail + data).slice(-300)
    if (this.busy) return
    const marked = this.tail.match(MARKED_PROMPT)
    const host = marked ? hostOfMarker(marked[1]) : undefined
    if (host) return this.auto(host, async () => {
      const s = await sudoSecretFor(host)
      return s.guard ? s.value : null
    })
    if (LOCAL_PROMPT.test(this.tail) && this.foreground() === 'sudo') {
      this.auto(LOCAL, () => passGetSecret(sudoEntry()).catch(() => null))
    }
  }

  private foreground(): string {
    try {
      return this.pty.process === 'sudo-rs' ? 'sudo' : this.pty.process
    } catch {
      return ''
    }
  }

  private auto(key: string, read: () => Promise<string | null>): void {
    this.tail = ''
    if (this.rejected.has(key) && this.rejected.get(key) === sudoVersion(key)) return
    this.busy = true
    void read()
      .catch(() => null)
      .then((password) => {
        this.busy = false
        if (!password) return
        this.rejected.delete(key)
        this.last = { key, at: Date.now() }
        this.pty.write(password + '\r')
      })
  }

  /**
   * Ctrl+Alt+P: the saved sudo password for what runs in this terminal: the
   * host's, when the foreground is the SSH shell Tendril opened for it, else
   * this machine's. Resolves with a reason when there is nothing to paste.
   */
  async pasteByHand(): Promise<string | null> {
    const host = this.foreground() === 'ssh' ? terminalHost(this.terminal) : undefined
    const password = host ? (await sudoSecretFor(host)).value : await passGetSecret(sudoEntry()).catch(() => null)
    if (!password) {
      return host
        ? `No sudo password is saved for ${host}. Add one in Settings › SSH (or tick “Same as login password”).`
        : 'No sudo password is saved for this machine. Add it in Settings › SSH.'
    }
    this.pty.write(password + '\r')
    return null
  }
}
