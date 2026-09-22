import type { ThemeDef, ThemePalette } from '../../preload/index'

/**
 * Turn an Obsidian theme.css into a Tendril palette. Only the CSS custom
 * properties declared on `.theme-light` / `.theme-dark` / `body` / `:root` are
 * used; every other rule targets Obsidian's DOM and is discarded, so nothing
 * from the theme can restyle Tendril directly.
 */

// Exactly `body`, `html`, `:root`, `.theme-dark`, `body.theme-light`, … — nothing
// more specific, so opt-in variants (`body.theme-dark.encore-colors-colorful`,
// `.is-mobile.theme-dark`) are ignored the way they would be in Obsidian by default.
const KEEP = /^(?:(body|html|:root)\s*)?(\.theme-(light|dark))?$/

/** Extract only variable declarations from palette-bearing rules. Pure; unit-tested. */
export function extractPaletteCss(css: string): string {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: string[] = []
  // Walk top-level blocks; nested @media/@supports are entered but other at-rules skipped.
  const walk = (src: string): void => {
    let i = 0
    while (i < src.length) {
      const open = src.indexOf('{', i)
      if (open < 0) break
      // Stray closing braces (unbalanced CSS is common in themes) are not part of the selector.
      const selector = src.slice(i, open).replace(/^[\s;}]+/, '').trim()
      const close = matchBrace(src, open)
      if (close < 0) break
      const body = src.slice(open + 1, close)
      if (selector.startsWith('@media') || selector.startsWith('@supports')) walk(body)
      else if (!selector.startsWith('@') && selector.split(',').some((s) => keep(s))) {
        const vars = declarations(body).filter((d) => d.startsWith('--') && !/url\(/i.test(d))
        if (vars.length) out.push(`${normaliseSelector(selector)}{${vars.join(';')}}`)
      }
      i = close + 1
    }
  }
  walk(css)
  return out.join('\n')
}

function keep(selector: string): boolean {
  const s = selector.trim()
  return s !== '' && KEEP.test(s)
}

/** Split a rule body on `;` outside quotes and parentheses (data: URLs contain `;`). */
function declarations(body: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote = ''
  let depth = 0
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (quote) {
      if (ch === '\\') cur += body[i++]
      else if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (ch === ';' && depth === 0) {
      out.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out.filter(Boolean)
}

function matchBrace(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return i
  }
  return -1
}

/** Re-target selectors at the probe so `body`/`:root` rules apply to it too. */
function normaliseSelector(selector: string): string {
  return selector
    .split(',')
    .map((s) => s.trim())
    .filter(keep)
    .map((s) => {
      const m = s.match(/\.theme-(light|dark)/)
      return m ? `#obsidian-probe.theme-${m[1]}` : '#obsidian-probe'
    })
    .join(',')
}

// Obsidian's own defaults that themes commonly derive from.
const OBSIDIAN_BASE = `#obsidian-probe{
  --accent-h:254;--accent-s:80%;--accent-l:68%;
  --font-interface:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  --font-text:var(--font-text-override),var(--font-text-theme),var(--font-interface);
  --font-monospace:var(--font-monospace-override),var(--font-monospace-theme),ui-monospace,Menlo,monospace;
  --font-text-theme:var(--font-interface);--font-monospace-theme:ui-monospace,Menlo,monospace;
  --font-text-override:var(--font-interface);--font-monospace-override:ui-monospace,Menlo,monospace;
  --color-base-00:#ffffff;--color-base-10:#fafafa;--color-base-20:#f6f6f6;--color-base-25:#e3e3e3;--color-base-30:#e0e0e0;
  --color-base-35:#d4d4d4;--color-base-40:#bdbdbd;--color-base-50:#ababab;--color-base-60:#707070;--color-base-70:#5a5a5a;--color-base-100:#222222;
  --color-accent:hsl(var(--accent-h),var(--accent-s),var(--accent-l));
  --color-accent-1:hsl(var(--accent-h),var(--accent-s),calc(var(--accent-l) - 3.8%));
  --color-accent-2:hsl(var(--accent-h),var(--accent-s),calc(var(--accent-l) + 3.8%));
  --color-red:#e93147;--color-orange:#ec7500;--color-yellow:#e0ac00;--color-green:#08b94e;--color-cyan:#00bfbc;--color-blue:#086ddd;--color-purple:#7852ee;--color-pink:#d53984;
  --background-primary:var(--color-base-00);--background-primary-alt:var(--color-base-10);--background-secondary:var(--color-base-20);
  --background-modifier-border:var(--color-base-30);--background-modifier-hover:rgba(0,0,0,0.075);--background-modifier-active-hover:hsla(var(--accent-h),var(--accent-s),var(--accent-l),0.15);
  --text-normal:var(--color-base-100);--text-muted:var(--color-base-70);--text-faint:var(--color-base-50);
  --text-accent:var(--color-accent);--text-accent-hover:var(--color-accent-2);--interactive-accent:var(--color-accent);
  --text-selection:hsla(var(--accent-h),var(--accent-s),var(--accent-l),0.2);--text-highlight-bg:rgba(255,208,0,0.4);
  --code-background:var(--background-primary-alt);--hr-color:var(--background-modifier-border);
  --link-color:var(--text-accent);--blockquote-border-color:var(--interactive-accent);
}
#obsidian-probe.theme-dark{
  --color-base-00:#1e1e1e;--color-base-10:#242424;--color-base-20:#262626;--color-base-25:#2a2a2a;--color-base-30:#363636;
  --color-base-35:#3f3f3f;--color-base-40:#555555;--color-base-50:#666666;--color-base-60:#999999;--color-base-70:#b3b3b3;--color-base-100:#dadada;
  --background-modifier-hover:rgba(255,255,255,0.075);
}`

const MAP: Record<keyof Omit<ThemePalette, 'syntax'>, string[]> = {
  bg: ['--background-primary'],
  barBg: ['--background-secondary'],
  border: ['--background-modifier-border'],
  fg: ['--text-normal'],
  muted: ['--text-muted'],
  hover: ['--background-modifier-hover'],
  active: ['--background-modifier-active-hover'],
  inset: ['--background-primary-alt'],
  selection: ['--text-selection'],
  accent: ['--interactive-accent', '--text-accent'],
  codeBg: ['--code-background'],
  hrColor: ['--hr-color'],
  headingColor: ['--h1-color'],
  linkColor: ['--link-color'],
  blockquoteBorder: ['--blockquote-border-color'],
  highlightBg: ['--text-highlight-bg'],
  fontText: ['--font-text'],
  fontMono: ['--font-monospace']
}
const FONT_KEYS = new Set(['fontText', 'fontMono'])

/** Resolve one mode's palette by letting Chromium evaluate the variable chains. */
function resolveMode(paletteCss: string, mode: 'light' | 'dark'): ThemePalette | undefined {
  const style = document.createElement('style')
  style.textContent = OBSIDIAN_BASE + '\n' + paletteCss
  const probe = document.createElement('div')
  probe.id = 'obsidian-probe'
  probe.className = `theme-${mode}`
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none'
  document.head.appendChild(style)
  document.body.appendChild(probe)
  try {
    const out: Partial<ThemePalette> = {}
    for (const [key, vars] of Object.entries(MAP) as [keyof typeof MAP, string[]][]) {
      for (const v of vars) {
        const value = FONT_KEYS.has(key) ? readFont(probe, v) : readColor(probe, v)
        if (value) {
          out[key] = value
          break
        }
      }
    }
    if (!out.bg || !out.fg) return undefined
    return {
      bg: out.bg,
      fg: out.fg,
      barBg: out.barBg ?? out.bg,
      border: out.border ?? mix(out.fg, out.bg, 0.2),
      muted: out.muted ?? mix(out.fg, out.bg, 0.6),
      hover: out.hover ?? mix(out.fg, out.bg, 0.08),
      active: out.active ?? mix(out.fg, out.bg, 0.14),
      inset: out.inset ?? out.barBg ?? out.bg,
      selection: out.selection ?? mix(out.accent ?? out.fg, out.bg, 0.25),
      accent: out.accent ?? out.fg,
      ...pick(out, ['codeBg', 'hrColor', 'headingColor', 'linkColor', 'blockquoteBorder', 'highlightBg', 'fontText', 'fontMono'])
    }
  } finally {
    probe.remove()
    style.remove()
  }
}

function pick<T extends object, K extends keyof T>(o: Partial<T>, keys: K[]): Partial<Pick<T, K>> {
  const r: Partial<Pick<T, K>> = {}
  for (const k of keys) if (o[k] !== undefined) r[k] = o[k]
  return r
}

/** Assigning the variable to a real property makes calc()/hsl()/rgb(var()) evaluate. */
function readColor(probe: HTMLElement, variable: string): string | undefined {
  if (!getComputedStyle(probe).getPropertyValue(variable).trim()) return undefined
  probe.style.color = ''
  probe.style.color = `var(${variable})`
  const c = getComputedStyle(probe).color
  return c && c !== 'rgba(0, 0, 0, 0)' ? c : undefined
}

function readFont(probe: HTMLElement, variable: string): string | undefined {
  const raw = getComputedStyle(probe).getPropertyValue(variable).trim()
  if (!raw) return undefined
  probe.style.fontFamily = `var(${variable})`
  const f = getComputedStyle(probe).fontFamily
  // Only keep a real family list; Obsidian's chained var() defaults collapse to the UI stack.
  return f && !/^(-apple-system|ui-monospace)/.test(f) ? f : undefined
}

/** Blend two rgb()/rgba() strings: t=0 → b, t=1 → a. Flattens alpha onto b. */
export function mix(a: string, b: string, t: number): string {
  const pa = parseRgb(a), pb = parseRgb(b)
  if (!pa || !pb) return a
  const ch = (i: number): number => Math.round(pb[i] + (pa[i] - pb[i]) * t * pa[3])
  return `rgb(${ch(0)}, ${ch(1)}, ${ch(2)})`
}

function parseRgb(s: string): [number, number, number, number] | null {
  const m = s.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?/)
  if (!m) return null
  const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])
  return [+m[1], +m[2], +m[3], a]
}

export function importObsidianTheme(
  repo: string,
  css: string,
  name: string,
  author: string,
  modes: ('light' | 'dark')[]
): ThemeDef {
  const paletteCss = extractPaletteCss(css)
  const def: ThemeDef = { id: `obsidian:${repo}`, name, author, repo }
  // A mode the theme never styles would just be Obsidian's defaults; keep only
  // modes the catalogue advertises or the CSS addresses explicitly.
  const has = (m: 'light' | 'dark'): boolean => modes.includes(m) || paletteCss.includes(`.theme-${m}`)
  const light = has('light') ? resolveMode(paletteCss, 'light') : undefined
  const dark = has('dark') ? resolveMode(paletteCss, 'dark') : undefined
  if (light) def.light = light
  if (dark) def.dark = dark
  if (!def.light && !def.dark) throw new Error('No palette found in theme.css')
  return def
}
