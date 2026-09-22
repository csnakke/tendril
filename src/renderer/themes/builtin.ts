import type { ThemeDef, ThemePalette } from '../../preload/index'
import adrenaline from './bundled/adrenaline.json'
import encore from './bundled/encore.json'

/**
 * Bundled palettes, transcribed from each project's official colour spec.
 * Adrenaline and Encore are Obsidian themes pre-imported with the same
 * extractor the in-app browser uses (regenerate: `npm run import-theme -- <repo>`).
 */

const p = (o: ThemePalette): ThemePalette => o

export const BUILTIN_THEMES: ThemeDef[] = [
  {
    id: 'builtin:catppuccin',
    name: 'Catppuccin',
    author: 'Catppuccin',
    light: p({
      bg: '#eff1f5', barBg: '#e6e9ef', border: '#ccd0da', fg: '#4c4f69', muted: '#6c6f85',
      hover: '#e6e9ef', active: '#ccd0da', inset: '#dce0e8', selection: '#ccd0da', accent: '#1e66f5',
      codeBg: '#e6e9ef', hrColor: '#ccd0da', linkColor: '#1e66f5', blockquoteBorder: '#8839ef', highlightBg: '#df8e1d55',
      syntax: { heading: '#8839ef', emphasis: '#fe640b', link: '#1e66f5', code: '#40a02b', quote: '#179299', meta: '#9ca0b0', keyword: '#8839ef', string: '#40a02b', comment: '#9ca0b0' }
    }),
    dark: p({
      bg: '#1e1e2e', barBg: '#181825', border: '#313244', fg: '#cdd6f4', muted: '#a6adc8',
      hover: '#313244', active: '#45475a', inset: '#11111b', selection: '#45475a', accent: '#89b4fa',
      codeBg: '#181825', hrColor: '#313244', linkColor: '#89b4fa', blockquoteBorder: '#cba6f7', highlightBg: '#f9e2af55',
      syntax: { heading: '#cba6f7', emphasis: '#fab387', link: '#89b4fa', code: '#a6e3a1', quote: '#94e2d5', meta: '#6c7086', keyword: '#cba6f7', string: '#a6e3a1', comment: '#6c7086' }
    })
  },
  {
    id: 'builtin:nord',
    name: 'Nord',
    author: 'Arctic Ice Studio',
    light: p({
      bg: '#eceff4', barBg: '#e5e9f0', border: '#d8dee9', fg: '#2e3440', muted: '#4c566a',
      hover: '#e5e9f0', active: '#d8dee9', inset: '#e5e9f0', selection: '#c8d0e0', accent: '#5e81ac',
      codeBg: '#e5e9f0', hrColor: '#d8dee9', linkColor: '#5e81ac', blockquoteBorder: '#81a1c1', highlightBg: '#ebcb8b66',
      syntax: { heading: '#5e81ac', emphasis: '#d08770', link: '#5e81ac', code: '#a3be8c', quote: '#8fbcbb', meta: '#7b88a1', keyword: '#81a1c1', string: '#a3be8c', comment: '#7b88a1' }
    }),
    dark: p({
      bg: '#2e3440', barBg: '#3b4252', border: '#434c5e', fg: '#d8dee9', muted: '#8f9bb3',
      hover: '#3b4252', active: '#434c5e', inset: '#3b4252', selection: '#434c5e', accent: '#88c0d0',
      codeBg: '#3b4252', hrColor: '#434c5e', linkColor: '#88c0d0', blockquoteBorder: '#81a1c1', highlightBg: '#ebcb8b55',
      syntax: { heading: '#88c0d0', emphasis: '#d08770', link: '#88c0d0', code: '#a3be8c', quote: '#8fbcbb', meta: '#6f7d99', keyword: '#81a1c1', string: '#a3be8c', comment: '#6f7d99' }
    })
  },
  {
    id: 'builtin:rose-pine',
    name: 'Rosé Pine',
    author: 'Rosé Pine',
    light: p({
      bg: '#faf4ed', barBg: '#fffaf3', border: '#dfdad9', fg: '#575279', muted: '#797593',
      hover: '#f4ede8', active: '#dfdad9', inset: '#f2e9e1', selection: '#dfdad9', accent: '#907aa9',
      codeBg: '#f2e9e1', hrColor: '#dfdad9', linkColor: '#286983', blockquoteBorder: '#d7827e', highlightBg: '#ea9d3455',
      syntax: { heading: '#907aa9', emphasis: '#d7827e', link: '#286983', code: '#56949f', quote: '#797593', meta: '#9893a5', keyword: '#286983', string: '#ea9d34', comment: '#9893a5' }
    }),
    dark: p({
      bg: '#191724', barBg: '#1f1d2e', border: '#26233a', fg: '#e0def4', muted: '#908caa',
      hover: '#21202e', active: '#403d52', inset: '#1f1d2e', selection: '#403d52', accent: '#c4a7e7',
      codeBg: '#1f1d2e', hrColor: '#403d52', linkColor: '#9ccfd8', blockquoteBorder: '#ebbcba', highlightBg: '#f6c17755',
      syntax: { heading: '#c4a7e7', emphasis: '#ebbcba', link: '#9ccfd8', code: '#31748f', quote: '#908caa', meta: '#6e6a86', keyword: '#31748f', string: '#f6c177', comment: '#6e6a86' }
    })
  },
  {
    id: 'builtin:dracula',
    name: 'Dracula',
    author: 'Dracula Theme',
    dark: p({
      bg: '#282a36', barBg: '#21222c', border: '#191a21', fg: '#f8f8f2', muted: '#6272a4',
      hover: '#343746', active: '#44475a', inset: '#21222c', selection: '#44475a', accent: '#bd93f9',
      codeBg: '#21222c', hrColor: '#44475a', linkColor: '#8be9fd', blockquoteBorder: '#6272a4', highlightBg: '#f1fa8c55',
      syntax: { heading: '#bd93f9', emphasis: '#ffb86c', link: '#8be9fd', code: '#50fa7b', quote: '#f1fa8c', meta: '#6272a4', keyword: '#ff79c6', string: '#f1fa8c', comment: '#6272a4' }
    })
  },
  {
    id: 'builtin:one-dark',
    name: 'One Dark',
    author: 'Atom',
    dark: p({
      bg: '#282c34', barBg: '#21252b', border: '#181a1f', fg: '#abb2bf', muted: '#7f848e',
      hover: '#2c313a', active: '#3e4451', inset: '#21252b', selection: '#3e4451', accent: '#61afef',
      codeBg: '#21252b', hrColor: '#3e4451', linkColor: '#61afef', blockquoteBorder: '#5c6370', highlightBg: '#e5c07b55',
      syntax: { heading: '#e06c75', emphasis: '#d19a66', link: '#61afef', code: '#98c379', quote: '#56b6c2', meta: '#5c6370', keyword: '#c678dd', string: '#98c379', comment: '#5c6370' }
    })
  },
  adrenaline as ThemeDef,
  encore as ThemeDef
]
