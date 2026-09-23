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
      graphNote: '#7287fd', graphTag: '#40a02b', graphLink: '#bcc0cc', graphHighlight: '#fe640b', graphBg: '#eff1f5', graphFolder: '#40a02b',
      graphColors: ['#1e66f5', '#fe640b', '#40a02b', '#8839ef', '#df8e1d', '#179299', '#d20f39', '#ea76cb'],
      syntax: { heading: '#8839ef', emphasis: '#fe640b', link: '#1e66f5', code: '#40a02b', quote: '#179299', meta: '#9ca0b0', keyword: '#8839ef', string: '#40a02b', comment: '#9ca0b0' }
    }),
    dark: p({
      bg: '#1e1e2e', barBg: '#181825', border: '#313244', fg: '#cdd6f4', muted: '#a6adc8',
      hover: '#313244', active: '#45475a', inset: '#11111b', selection: '#45475a', accent: '#89b4fa',
      codeBg: '#181825', hrColor: '#313244', linkColor: '#89b4fa', blockquoteBorder: '#cba6f7', highlightBg: '#f9e2af55',
      graphNote: '#b4befe', graphTag: '#a6e3a1', graphLink: '#45475a', graphHighlight: '#fab387', graphBg: '#1e1e2e', graphFolder: '#a6e3a1',
      graphColors: ['#89b4fa', '#fab387', '#a6e3a1', '#cba6f7', '#f9e2af', '#94e2d5', '#f38ba8', '#f5c2e7'],
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
      graphNote: '#5e81ac', graphTag: '#8fbcbb', graphLink: '#d8dee9', graphHighlight: '#d08770', graphBg: '#eceff4', graphFolder: '#b48ead',
      graphColors: ['#5e81ac', '#d08770', '#a3be8c', '#b48ead', '#ebcb8b', '#8fbcbb', '#bf616a', '#88c0d0'],
      syntax: { heading: '#5e81ac', emphasis: '#d08770', link: '#5e81ac', code: '#a3be8c', quote: '#8fbcbb', meta: '#7b88a1', keyword: '#81a1c1', string: '#a3be8c', comment: '#7b88a1' }
    }),
    dark: p({
      bg: '#2e3440', barBg: '#3b4252', border: '#434c5e', fg: '#d8dee9', muted: '#8f9bb3',
      hover: '#3b4252', active: '#434c5e', inset: '#3b4252', selection: '#434c5e', accent: '#88c0d0',
      codeBg: '#3b4252', hrColor: '#434c5e', linkColor: '#88c0d0', blockquoteBorder: '#81a1c1', highlightBg: '#ebcb8b55',
      graphNote: '#88c0d0', graphTag: '#a3be8c', graphLink: '#4c566a', graphHighlight: '#ebcb8b', graphBg: '#2e3440', graphFolder: '#a3be8c',
      graphColors: ['#81a1c1', '#d08770', '#a3be8c', '#b48ead', '#ebcb8b', '#8fbcbb', '#bf616a', '#88c0d0'],
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
      graphNote: '#907aa9', graphTag: '#56949f', graphLink: '#dfdad9', graphHighlight: '#d7827e', graphBg: '#faf4ed', graphFolder: '#56949f',
      graphColors: ['#286983', '#d7827e', '#56949f', '#907aa9', '#ea9d34', '#b4637a'],
      syntax: { heading: '#907aa9', emphasis: '#d7827e', link: '#286983', code: '#56949f', quote: '#797593', meta: '#9893a5', keyword: '#286983', string: '#ea9d34', comment: '#9893a5' }
    }),
    dark: p({
      bg: '#191724', barBg: '#1f1d2e', border: '#26233a', fg: '#e0def4', muted: '#908caa',
      hover: '#21202e', active: '#403d52', inset: '#1f1d2e', selection: '#403d52', accent: '#c4a7e7',
      codeBg: '#1f1d2e', hrColor: '#403d52', linkColor: '#9ccfd8', blockquoteBorder: '#ebbcba', highlightBg: '#f6c17755',
      graphNote: '#c4a7e7', graphTag: '#9ccfd8', graphLink: '#403d52', graphHighlight: '#ebbcba', graphBg: '#191724', graphFolder: '#9ccfd8',
      graphColors: ['#31748f', '#ebbcba', '#9ccfd8', '#c4a7e7', '#f6c177', '#eb6f92'],
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
      graphNote: '#bd93f9', graphTag: '#50fa7b', graphLink: '#44475a', graphHighlight: '#ffb86c', graphBg: '#282a36', graphFolder: '#50fa7b',
      graphColors: ['#8be9fd', '#ffb86c', '#50fa7b', '#bd93f9', '#f1fa8c', '#ff79c6', '#ff5555'],
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
      graphNote: '#61afef', graphTag: '#98c379', graphLink: '#3e4451', graphHighlight: '#e5c07b', graphBg: '#282c34', graphFolder: '#98c379',
      graphColors: ['#61afef', '#d19a66', '#98c379', '#c678dd', '#e5c07b', '#56b6c2', '#e06c75'],
      syntax: { heading: '#e06c75', emphasis: '#d19a66', link: '#61afef', code: '#98c379', quote: '#56b6c2', meta: '#5c6370', keyword: '#c678dd', string: '#98c379', comment: '#5c6370' }
    })
  },
  adrenaline as ThemeDef,
  encore as ThemeDef
]
