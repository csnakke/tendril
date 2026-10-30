import { icon } from './icons/index'
import { confirmBox } from './messageBox'
import { runInTerminal } from './terminal'

/**
 * Copy and Run on a note's code blocks (Markdown only; the preview and live
 * preview both add them). Run pastes a `bash`/`sh`/`zsh` block into the
 * built-in terminal's shell, or feeds a `py`/`python` block to python3, and
 * runs it. A note can come from anyone, so the first Run in each note asks
 * once; until Tendril restarts, that note runs without asking again.
 */

type Kind = 'shell' | 'python'
const RUNNABLE: Record<string, Kind> = { bash: 'shell', sh: 'shell', zsh: 'shell', shell: 'shell', py: 'python', python: 'python', python3: 'python' }

/** The block's language: the first word of the fence info (```bash title=x → bash). */
export const langOf = (info: string): string => info.trim().split(/[\s{]/)[0]?.toLowerCase() ?? ''
export const isRunnable = (lang: string): boolean => lang in RUNNABLE

let docKey: () => string = () => ''
/** Which note is on screen (its path, or its tab for an unsaved one): what "asked once" is remembered for. */
export function setDocKey(fn: () => string): void {
  docKey = fn
}
const trusted = new Set<string>()

export async function runCode(lang: string, code: string): Promise<void> {
  const kind = RUNNABLE[lang]
  const body = code.replace(/\s+$/, '')
  if (!kind || !body) return
  const key = docKey()
  if (!trusted.has(key)) {
    const preview = body.split('\n').slice(0, 6).join('\n') + (body.split('\n').length > 6 ? '\n…' : '')
    const ok = await confirmBox('Run code from this note?', `It runs in the built-in terminal${kind === 'python' ? ' with python3' : ''}:\n\n${preview}\n\nTendril won’t ask again for this note until it restarts.`, { ok: 'Run' })
    if (!ok) return
    trusted.add(key)
  }
  if (kind === 'shell') return runInTerminal(body)
  // A here-document with a delimiter the code cannot contain: no temp file, no quoting.
  let tag = 'TENDRIL_PY'
  while (body.includes(tag)) tag += '_'
  return runInTerminal(`python3 - <<'${tag}'\n${body}\n${tag}`)
}

/** Copy (any block) and Run (runnable ones) buttons; `code` is read at click time. */
export function codeActions(lang: string, code: () => string): HTMLElement {
  const bar = document.createElement('span')
  bar.className = 'code-actions'
  bar.contentEditable = 'false'
  const button = (label: string, name: 'copy' | 'play', act: (b: HTMLButtonElement) => void): void => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = `code-${name === 'play' ? 'run' : 'copy'}`
    b.title = label
    b.innerHTML = `${icon(name)}<span>${name === 'play' ? 'Run' : 'Copy'}</span>`
    // Keep the editor's selection (and focus) where it is.
    b.addEventListener('mousedown', (e) => e.preventDefault())
    b.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      act(b)
    })
    bar.appendChild(b)
  }
  button('Copy the code', 'copy', (b) => {
    void navigator.clipboard.writeText(code()).then(() => {
      b.classList.add('done')
      b.querySelector('span')!.textContent = 'Copied'
      setTimeout(() => {
        b.classList.remove('done')
        b.querySelector('span')!.textContent = 'Copy'
      }, 1200)
    })
  })
  if (isRunnable(lang)) button(RUNNABLE[lang] === 'python' ? 'Run with python3 in the terminal' : 'Run in the terminal', 'play', () => void runCode(lang, code()))
  return bar
}

/** Add the buttons to every code block of a rendered note (the preview). */
export function decorateCodeBlocks(root: HTMLElement): void {
  for (const code of root.querySelectorAll<HTMLElement>('pre > code')) {
    const pre = code.parentElement!
    if (pre.querySelector('.code-actions')) continue
    const lang = langOf((code.className.match(/language-(\S+)/) ?? [])[1] ?? '')
    pre.classList.add('has-code-actions')
    pre.appendChild(codeActions(lang, () => code.textContent ?? ''))
  }
}
