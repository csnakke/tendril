#!/usr/bin/env node
/**
 * Pre-import an Obsidian theme's palette into src/renderer/themes/bundled/.
 *   npm run import-theme -- <owner/repo> [slug]
 * Runs the built app headlessly (needs `npm run compile` output in out/) and
 * uses the same extractor the in-app browser uses.
 */
const { execFileSync } = require('child_process')
const { readFileSync, writeFileSync, mkdtempSync } = require('fs')
const { join } = require('path')
const { tmpdir } = require('os')

const [repo, slugArg] = process.argv.slice(2)
if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
  console.error('usage: import-obsidian-theme <owner/repo> [slug]')
  process.exit(2)
}
const root = join(__dirname, '..')
const out = join(mkdtempSync(join(tmpdir(), 'tendril-theme-')), 'theme.json')
const electron = require('electron')
execFileSync(electron, ['--no-sandbox', join(root, 'out/main/index.js')], {
  stdio: 'ignore',
  env: {
    ...process.env,
    TENDRIL_AUTOJS: `window.__importObsidianTheme(${JSON.stringify(repo)})`,
    TENDRIL_AUTOJS_OUT: out,
    TENDRIL_AUTOQUIT: '1'
  }
})
const def = JSON.parse(readFileSync(out, 'utf8'))
const slug = slugArg || def.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
def.id = `builtin:${slug}`
def.licence = `See https://github.com/${repo} (palette only; imported ${new Date().toISOString().slice(0, 10)})`
const target = join(root, 'src/renderer/themes/bundled', `${slug}.json`)
writeFileSync(target, JSON.stringify(def, null, 2) + '\n')
console.log(`wrote ${target} (${['light', 'dark'].filter((m) => def[m]).join(', ')})`)
