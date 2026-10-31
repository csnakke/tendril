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
 *
 * In tmux the prompt can wait in any pane, so the password goes to the pane
 * whose screen ends with it and whose foreground program is sudo (or the ssh
 * of that session); by hand, to the pane in front.
 */

const LOCAL_PROMPT = /(?:\[sudo\] password for [^\s:]+|\[sudo: authenticate\] Password):\s*$/
/** The marker prompt as sudo prints it: %p expanded to a real user name (not the echoed command). */
const MARKED_PROMPT = /\[sudo:([0-9a-f]{24})\] password for [^\s%:]+: *$/
/** The same prompts anywhere in the output: enough to look, when the screen itself decides (tmux). */
const LOCAL_SEEN = /\[sudo\] password for [^\s:]+:|\[sudo: authenticate\] Password:/
const MARKED_SEEN = /\[sudo:([0-9a-f]{24})\] password for [^\s%:]+:/g
const REJECTED = /Sorry, try again|incorrect password|Authentication failure/i
/** Terminal escapes (colours, cursor moves, titles): tmux redraws a prompt with them around it. */
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[()][0-9A-Za-z]|\x1b[=>78DEHMc]|\r/g

/** What runs in a terminal, as far as pasting goes: a plain shell, or a tmux session (main/terminal.ts). */
export interface SudoShell {
  /** promptPane checks the screen (tmux), so the output only has to show the prompt somewhere. */
  screen: boolean
  /** The foreground program in front (the active pane). */
  active(): Promise<string>
  /** Where `prompt` waits with one of `commands` in the foreground, or null. */
  promptPane(commands: string[], prompt: RegExp): Promise<string | null>
  paste(pane: string, text: string): Promise<void>
  /** Type into whatever is in front. */
  pasteActive(text: string): Promise<void>
}

export class SudoFill {
  private tail = ''
  private busy = false
  /** The last automatic paste, to tell whether sudo turned it down. */
  private last: { key: string; at: number } | null = null
  /** Passwords turned down here, with the version they had: not pasted again until changed. */
  private readonly rejected = new Map<string, number>()

  constructor(
    private readonly shell: SudoShell,
    private readonly terminal: number
  ) {}

  feed(data: string): void {
    const text = data.replace(ESCAPES, '')
    if (this.last && Date.now() - this.last.at < 10_000 && REJECTED.test(text)) {
      this.rejected.set(this.last.key, sudoVersion(this.last.key))
      this.last = null
      this.tail = ''
      return
    }
    this.tail = (this.tail + text).slice(-300)
    if (this.busy) return
    const marker = this.shell.screen ? [...this.tail.matchAll(MARKED_SEEN)].pop()?.[1] : this.tail.match(MARKED_PROMPT)?.[1]
    const host = marker ? hostOfMarker(marker) : undefined
    if (host) {
      const prompt = new RegExp(`\\[sudo:${marker}\\] password for [^\\s%:]+: *$`)
      return this.auto(host, ['ssh'], prompt, async () => {
        const s = await sudoSecretFor(host)
        return s.guard ? s.value : null
      })
    }
    if ((this.shell.screen ? LOCAL_SEEN : LOCAL_PROMPT).test(this.tail)) {
      this.auto(LOCAL, ['sudo'], LOCAL_PROMPT, () => passGetSecret(sudoEntry()).catch(() => null))
    }
  }

  private auto(key: string, commands: string[], prompt: RegExp, read: () => Promise<string | null>): void {
    this.tail = ''
    if (this.rejected.has(key) && this.rejected.get(key) === sudoVersion(key)) return
    this.busy = true
    void (async () => {
      const pane = await this.shell.promptPane(commands, prompt)
      const password = pane ? await read() : null
      if (!pane || !password) return
      this.rejected.delete(key)
      this.last = { key, at: Date.now() }
      await this.shell.paste(pane, password)
    })()
      .catch(() => {})
      .finally(() => (this.busy = false))
  }

  /**
   * Ctrl+Alt+P: the saved sudo password for what runs in front: the host's,
   * when that is the SSH shell Tendril opened for it, else this machine's.
   * Resolves with a reason when there is nothing to paste.
   */
  async pasteByHand(): Promise<string | null> {
    const host = (await this.shell.active()) === 'ssh' ? terminalHost(this.terminal) : undefined
    const password = host ? (await sudoSecretFor(host)).value : await passGetSecret(sudoEntry()).catch(() => null)
    if (!password) {
      return host
        ? `No sudo password is saved for ${host}. Add one in Settings › SSH (or tick “Same as login password”).`
        : 'No sudo password is saved for this machine. Add it in Settings › SSH.'
    }
    await this.shell.pasteActive(password)
    return null
  }
}
