import type { IPty } from 'node-pty'
import { passGetSecret } from './pass'
import { sudoEntry } from './remote'

/**
 * Fills in this machine's sudo password (saved in `pass`) when a terminal
 * shows sudo's prompt. Only a real local sudo counts: the prompt must have
 * sudo's exact form *and* the terminal's foreground process must be sudo, so
 * text that merely looks like a prompt (a remote server, a file being shown)
 * never gets the password. Once sudo rejects it, this terminal stops filling
 * it in and the person types it.
 */

const PROMPT = /(?:\[sudo\] password for [^\s:]+|\[sudo: authenticate\] Password):\s*$/
const REJECTED = /Sorry, try again|incorrect password|Authentication failure/i

export class SudoFill {
  private tail = ''
  private busy = false
  private filledAt = 0
  private rejected = false

  constructor(private readonly pty: IPty) {}

  feed(data: string): void {
    if (this.rejected) return
    if (this.filledAt && Date.now() - this.filledAt < 10_000 && REJECTED.test(data)) {
      this.rejected = true
      return
    }
    this.tail = (this.tail + data).slice(-200)
    if (this.busy || !PROMPT.test(this.tail)) return
    let fg = ''
    try {
      fg = this.pty.process
    } catch {
      /* exited */
    }
    if (fg !== 'sudo' && fg !== 'sudo-rs') return
    this.tail = ''
    this.busy = true
    void passGetSecret(sudoEntry())
      .catch(() => null)
      .then((password) => {
        this.busy = false
        if (!password || this.rejected) return
        this.filledAt = Date.now()
        this.pty.write(password + '\r')
      })
  }
}
