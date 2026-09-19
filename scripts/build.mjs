import { build } from 'esbuild'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const base = 'https://raw.githubusercontent.com/contione/tampermonkey-userscript/main/dist'
const header = `// ==UserScript==
// @name         Tempo for Jira
// @namespace    https://github.com/contione/tampermonkey-userscript
// @version      ${version}
// @description  Worklogs, schedules, aliases and persistent time trackers inside Jira Cloud.
// @author       contione
// @license      MIT
// @match        https://*.atlassian.net/*
// @connect      api.tempo.io
// @connect      self
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @noframes
// @updateURL    ${base}/tempo.meta.js
// @downloadURL  ${base}/tempo.user.js
// @supportURL   https://github.com/contione/tampermonkey-userscript/issues
// ==/UserScript==`
await mkdir('dist', { recursive: true })
await build({ entryPoints: ['src/main.ts'], bundle: true, format: 'iife', target: 'es2022',
  outfile: 'dist/tempo.user.js', banner: { js: header }, legalComments: 'inline', charset: 'utf8' })
await writeFile('dist/tempo.meta.js', `${header}\n`)
console.log(`Built Tempo for Jira ${version}`)
