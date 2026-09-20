// ==UserScript==
// @name         Tempo for Jira
// @namespace    https://github.com/contione/tampermonkey-userscript
// @version      0.1.4
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
// @updateURL    https://raw.githubusercontent.com/contione/tampermonkey-userscript/main/dist/tempo.meta.js
// @downloadURL  https://raw.githubusercontent.com/contione/tampermonkey-userscript/main/dist/tempo.user.js
// @supportURL   https://github.com/contione/tampermonkey-userscript/issues
// ==/UserScript==
