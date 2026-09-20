// ==UserScript==
// @name         Tempo for Jira
// @namespace    https://github.com/contione/tampermonkey-userscript
// @version      0.1.1
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
"use strict";
(() => {
  // src/http.ts
  var HttpError = class extends Error {
    method;
    status;
    data;
    responseHeaders;
    constructor(message, options) {
      super(message, { cause: options.cause });
      this.name = "HttpError";
      this.method = options.method;
      this.status = options.status;
      this.data = options.data;
      this.responseHeaders = options.responseHeaders;
    }
  };
  var DEFAULT_TIMEOUT_MS = 15e3;
  var MAX_GET_RETRIES = 2;
  var MAX_RETRY_WAIT_MS = DEFAULT_TIMEOUT_MS;
  var INITIAL_RETRY_WAIT_MS = 250;
  var gmTransport = (request) => new Promise((resolve, reject) => {
    let handle;
    const timer = setTimeout(() => {
      reject(new HttpError("Request timed out. Check Tempo before retrying a write.", { method: request.method }));
      handle?.abort();
    }, request.timeoutMs);
    const fail = (message) => {
      clearTimeout(timer);
      reject(new HttpError(message, { method: request.method }));
    };
    try {
      handle = GM_xmlhttpRequest({
        method: request.method,
        url: request.url,
        headers: request.headers,
        data: request.body,
        timeout: request.timeoutMs,
        anonymous: true,
        redirect: "error",
        onload: (response) => {
          clearTimeout(timer);
          resolve({
            status: response.status,
            responseText: response.responseText,
            responseHeaders: response.responseHeaders,
            finalUrl: response.finalUrl
          });
        },
        onerror: () => fail("Network request failed. Check your connection and token permissions."),
        ontimeout: () => fail("Request timed out. Check Tempo before retrying a write."),
        onabort: () => fail("Request aborted.")
      });
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
  async function requestJson(urlInput, options = {}) {
    const method = options.method ?? "GET";
    const url = new URL(urlInput.toString());
    const allowedOrigin = options.allowedOrigin;
    if (allowedOrigin) assertSameOrigin(url, allowedOrigin);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("HTTP timeout must be a positive number.");
    }
    const body = options.body === void 0 ? void 0 : typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    const headers = {
      Accept: "application/json",
      ...options.headers,
      ...body === void 0 ? {} : { "Content-Type": "application/json" }
    };
    const transport = options.transport ?? gmTransport;
    for (let retry = 0; ; retry += 1) {
      let response;
      try {
        response = await withTimeout(transport({
          method,
          url: url.toString(),
          headers,
          body,
          timeoutMs,
          anonymous: true,
          redirect: "error"
        }), timeoutMs, method);
      } catch (error2) {
        if (error2 instanceof HttpError) throw error2;
        throw new HttpError("Network request failed.", { method, cause: error2 });
      }
      if (response.finalUrl) {
        const finalUrl = new URL(response.finalUrl);
        if (finalUrl.origin !== url.origin) {
          throw new HttpError("Request redirected to another origin.", { method });
        }
      }
      const data = parseBody(response.responseText);
      if (response.status >= 200 && response.status < 300) {
        return {
          status: response.status,
          data,
          headers: response.responseHeaders,
          url: response.finalUrl ?? url.toString()
        };
      }
      const error = new HttpError(`HTTP ${response.status}`, {
        method,
        status: response.status,
        data,
        responseHeaders: response.responseHeaders
      });
      if (method !== "GET" || retry >= MAX_GET_RETRIES || !isRetryable(response.status)) {
        throw error;
      }
      const waitMs = retryWait(response.responseHeaders, retry);
      if (waitMs === void 0 || waitMs > MAX_RETRY_WAIT_MS) throw error;
      await delay(waitMs);
    }
  }
  function assertSameOrigin(url, allowedOrigin) {
    const expectedOrigin = new URL(allowedOrigin).origin;
    if (url.origin !== expectedOrigin) {
      throw new HttpError("Request origin is not allowed.", { method: "GET" });
    }
  }
  function parseBody(body) {
    if (!body || !body.trim()) return void 0;
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }
  function withTimeout(promise, timeoutMs, method) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new HttpError("Request timed out.", { method })), timeoutMs);
      promise.then(resolve, reject).finally(() => clearTimeout(timer));
    });
  }
  function isRetryable(status) {
    return status === 429 || status >= 500 && status <= 599;
  }
  function retryWait(headers, retry) {
    const retryAfter = getHeader(headers, "retry-after");
    if (retryAfter) {
      const seconds = Number(retryAfter.trim());
      if (Number.isFinite(seconds)) return Math.max(0, seconds * 1e3);
      const retryAt = Date.parse(retryAfter);
      if (Number.isFinite(retryAt)) return Math.max(0, retryAt - Date.now());
      return void 0;
    }
    return Math.min(INITIAL_RETRY_WAIT_MS * 2 ** retry, MAX_RETRY_WAIT_MS);
  }
  function getHeader(headers, name) {
    if (!headers) return void 0;
    if (typeof headers !== "string") {
      const key2 = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
      return key2 ? headers[key2] : void 0;
    }
    const line = headers.split(/\r?\n/).find((value) => value.toLowerCase().startsWith(`${name.toLowerCase()}:`));
    return line?.slice(line.indexOf(":") + 1).trim();
  }
  function delay(milliseconds) {
    if (milliseconds <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  // src/api.ts
  var TEMPO_ORIGIN = "https://api.tempo.io";
  var TEMPO_API_ORIGIN = `${TEMPO_ORIGIN}/4`;
  async function discoverAccount(input, transport = gmTransport) {
    const origin = normalizeAtlassianOrigin(input.hostname);
    const email = requireText(input.email, "Jira email");
    const jiraToken = requireText(input.jiraToken, "Jira token");
    try {
      const response = await requestJson(`${origin}/rest/api/3/myself`, {
        transport,
        allowedOrigin: origin,
        headers: { Authorization: `Basic ${basicAuth(email, jiraToken)}` }
      });
      return parseIdentity(response.data);
    } catch (error) {
      throw toApiError("Jira", error);
    }
  }
  function createApi(credentials, transport = gmTransport) {
    const config = normalizeCredentials(credentials);
    return {
      getIssueId: (issueKey) => execute("Jira", () => jiraJson(
        `/issue/${encodeURIComponent(requireText(issueKey, "Issue key"))}`,
        config,
        transport
      ).then((response) => {
        if (!isRecord(response.data)) throw new Error("Jira issue response is invalid.");
        return normalizeId(response.data.id, "Jira issue id");
      })),
      getIssueKey: (issueId) => execute("Jira", () => jiraJson(
        `/issue/${encodeURIComponent(requireText(issueId, "Issue id"))}`,
        config,
        transport
      ).then((response) => {
        if (!isRecord(response.data) || typeof response.data.key !== "string" || !response.data.key.trim()) {
          throw new Error("Jira issue response did not contain a key.");
        }
        return response.data.key;
      })),
      addWorklog: (input) => execute("Tempo", async () => {
        const issueId = positiveInteger(input.issueId, "issueId");
        const timeSpentSeconds = positiveInteger(input.timeSpentSeconds, "timeSpentSeconds");
        const body = {
          issueId,
          authorAccountId: config.accountId,
          timeSpentSeconds,
          startDate: requireText(input.startDate, "startDate"),
          startTime: requireText(input.startTime, "startTime")
        };
        if (input.description !== void 0) body.description = input.description;
        if (input.remainingEstimateSeconds !== void 0) {
          body.remainingEstimateSeconds = nonNegativeInteger(input.remainingEstimateSeconds, "remainingEstimateSeconds");
        }
        const response = await tempoJson("/worklogs", config, transport, {
          method: "POST",
          body
        });
        return parseWorklog(response.data);
      }),
      getWorklog: (id) => execute("Tempo", async () => {
        const response = await tempoJson(`/worklogs/${encodeURIComponent(requireText(id, "Worklog id"))}`, config, transport);
        return parseWorklog(response.data);
      }),
      deleteWorklog: (id) => execute("Tempo", async () => {
        await tempoJson(`/worklogs/${encodeURIComponent(requireText(id, "Worklog id"))}`, config, transport, {
          method: "DELETE"
        });
      }),
      getWorklogs: (from, to) => execute("Tempo", async () => {
        const url = tempoUrl(`/worklogs/user/${encodeURIComponent(config.accountId)}`);
        url.searchParams.set("from", requireText(from, "from date"));
        url.searchParams.set("to", requireText(to, "to date"));
        url.searchParams.set("limit", "1000");
        const results = [];
        const visited = /* @__PURE__ */ new Set();
        let next = url;
        let pages = 0;
        while (next) {
          const pageUrl = next.toString();
          if (visited.has(pageUrl)) throw new Error("Tempo pagination loop detected.");
          visited.add(pageUrl);
          if (++pages > 100) throw new Error("Tempo pagination exceeded the safety limit.");
          const response = await tempoJson(pageUrl, config, transport);
          const page = parseWorklogPage(response.data);
          results.push(...page.results);
          next = resolveTempoNext(page.next, response.url);
        }
        return results;
      }),
      getSchedule: (from, to) => execute("Tempo", async () => {
        const url = tempoUrl("/user-schedule");
        url.searchParams.set("from", requireText(from, "from date"));
        url.searchParams.set("to", requireText(to, "to date"));
        const response = await tempoJson(url, config, transport);
        return parseSchedule(response.data);
      })
    };
  }
  async function tempoJson(input, credentials, transport, options = {}) {
    const url = tempoUrl(input);
    return requestJson(url, {
      ...options,
      transport,
      allowedOrigin: TEMPO_ORIGIN,
      headers: { Authorization: `Bearer ${credentials.tempoToken}` }
    });
  }
  async function jiraJson(input, credentials, transport) {
    const url = jiraUrl(input, credentials.jiraOrigin);
    return requestJson(url, {
      transport,
      allowedOrigin: credentials.jiraOrigin,
      headers: { Authorization: `Basic ${basicAuth(credentials.email, credentials.jiraToken)}` }
    });
  }
  function normalizeCredentials(credentials) {
    const jiraOrigin = normalizeAtlassianOrigin(credentials.hostname);
    return {
      hostname: credentials.hostname,
      email: requireText(credentials.email, "Jira email"),
      jiraToken: requireText(credentials.jiraToken, "Jira token"),
      tempoToken: requireText(credentials.tempoToken, "Tempo token"),
      accountId: requireText(credentials.accountId, "Jira accountId"),
      jiraOrigin
    };
  }
  function normalizeAtlassianOrigin(hostname) {
    const value = requireText(hostname, "Jira hostname");
    let url;
    try {
      url = new URL(value.includes("://") ? value : `https://${value}`);
    } catch {
      throw new Error("Jira hostname is invalid.");
    }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash || host === "atlassian.net" || !host.endsWith(".atlassian.net")) {
      throw new Error("Jira hostname must be an HTTPS *.atlassian.net host.");
    }
    return url.origin;
  }
  function tempoUrl(input) {
    if (input instanceof URL) return new URL(input.toString());
    if (/^https?:\/\//i.test(input)) return new URL(input);
    return new URL(input.replace(/^\/+/, ""), `${TEMPO_API_ORIGIN}/`);
  }
  function jiraUrl(input, origin) {
    if (input instanceof URL) {
      const url = new URL(input.toString());
      if (url.origin !== origin) throw new Error("Jira request origin is not allowed.");
      return url;
    }
    if (/^https?:\/\//i.test(input)) {
      const url = new URL(input);
      if (url.origin !== origin) throw new Error("Jira request origin is not allowed.");
      return url;
    }
    return new URL(input.replace(/^\/+/, ""), `${origin}/rest/api/3/`);
  }
  function resolveTempoNext(next, currentUrl) {
    if (!next) return void 0;
    const url = new URL(next, currentUrl);
    if (url.origin !== TEMPO_ORIGIN) throw new Error("Tempo pagination origin is not allowed.");
    return url;
  }
  function parseIdentity(value) {
    if (!isRecord(value) || typeof value.accountId !== "string" || !value.accountId.trim()) {
      throw new Error("Jira /myself did not return an accountId.");
    }
    if (value.active !== true) throw new Error("The Jira user is inactive.");
    return {
      accountId: value.accountId.trim(),
      displayName: typeof value.displayName === "string" ? value.displayName : ""
    };
  }
  function parseWorklogPage(value) {
    if (!isRecord(value) || !Array.isArray(value.results)) throw new Error("Tempo worklogs response is invalid.");
    const metadata = isRecord(value.metadata) ? value.metadata : void 0;
    if (metadata?.next !== void 0 && typeof metadata.next !== "string") {
      throw new Error("Tempo pagination link is invalid.");
    }
    return {
      results: value.results.map(parseWorklog),
      ...typeof metadata?.next === "string" && metadata.next ? { next: metadata.next } : {}
    };
  }
  function parseWorklog(value) {
    if (!isRecord(value)) throw new Error("Tempo worklog response is invalid.");
    const issue = isRecord(value.issue) ? value.issue : void 0;
    const issueId = value.issueId ?? issue?.id;
    const id = value.id ?? value.tempoWorklogId;
    const timeSpentSeconds = finiteNumber(value.timeSpentSeconds);
    if (timeSpentSeconds === void 0) throw new Error("Tempo worklog duration is invalid.");
    if (typeof value.startDate !== "string" || typeof value.startTime !== "string") {
      throw new Error("Tempo worklog date is invalid.");
    }
    return {
      id: normalizeId(id, "Tempo worklog id"),
      issueId: normalizeId(issueId, "Tempo issue id"),
      startDate: value.startDate,
      startTime: value.startTime,
      timeSpentSeconds,
      description: typeof value.description === "string" ? value.description : ""
    };
  }
  function parseSchedule(value) {
    if (!isRecord(value) || !Array.isArray(value.results)) throw new Error("Tempo schedule response is invalid.");
    return value.results.map((item) => {
      if (!isRecord(item) || typeof item.date !== "string" || typeof item.type !== "string") {
        throw new Error("Tempo schedule entry is invalid.");
      }
      const requiredSeconds = finiteNumber(item.requiredSeconds);
      if (requiredSeconds === void 0) throw new Error("Tempo schedule duration is invalid.");
      return { date: item.date, requiredSeconds, type: item.type };
    });
  }
  function normalizeId(value, label) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
    throw new Error(`${label} is invalid.`);
  }
  function positiveInteger(value, label) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
    if (typeof value === "string" && /^\d+$/.test(value.trim())) {
      const parsed = Number(value);
      if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
    }
    throw new Error(`${label} must be a positive integer.`);
  }
  function nonNegativeInteger(value, label) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
    throw new Error(`${label} must be a non-negative integer.`);
  }
  function finiteNumber(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
    return void 0;
  }
  function requireText(value, label) {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
    return value.trim();
  }
  function basicAuth(email, token) {
    const bytes = new TextEncoder().encode(`${email}:${token}`);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
  async function execute(service, action) {
    try {
      return await action();
    } catch (error) {
      throw toApiError(service, error);
    }
  }
  function toApiError(service, error) {
    if (!(error instanceof HttpError)) return error instanceof Error ? error : new Error(String(error));
    if (error.status === 401 || error.status === 403) {
      return new Error(`Unauthorized access to ${service}. Check the configured credentials and permissions.`);
    }
    const messages = service === "Jira" ? jiraMessages(error.data) : tempoMessages(error.data);
    if (messages.length > 0) return new Error(`Failure (${service} API). Errors: ${messages.join(", ")}`);
    if (error.status) return new Error(`Failure (${service} API). Server status code: ${error.status}.`);
    return new Error(error.message);
  }
  function jiraMessages(value) {
    if (!isRecord(value)) return [];
    const messages = [];
    if (Array.isArray(value.errorMessages)) {
      messages.push(...value.errorMessages.filter((item) => typeof item === "string"));
    }
    if (isRecord(value.errors)) {
      messages.push(...Object.values(value.errors).filter((item) => typeof item === "string"));
    }
    return messages;
  }
  function tempoMessages(value) {
    if (!isRecord(value)) return [];
    const errors = value.errors;
    if (Array.isArray(errors)) {
      return errors.flatMap((item) => {
        if (typeof item === "string") return [item];
        if (isRecord(item) && typeof item.message === "string") return [item.message];
        return [];
      });
    }
    if (isRecord(errors)) return Object.values(errors).filter((item) => typeof item === "string");
    if (typeof errors === "string") return [errors];
    if (typeof value.message === "string") return [value.message];
    return [];
  }
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  // src/domain.ts
  function day(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }
  function resolveDate(input, now = /* @__PURE__ */ new Date()) {
    const value = input.trim().toLowerCase();
    if (!value || value === "today" || value === "t") return day(now);
    if (value === "y" || value === "yesterday") return shifted(now, -1);
    const relative = /^(?:today|t)([+-]\d+)$/.exec(value);
    if (relative) return shifted(now, Number(relative[1]));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Use YYYY-MM-DD, yesterday or today±N for the date.");
    const date = /* @__PURE__ */ new Date(`${value}T00:00:00`);
    if (!Number.isFinite(date.getTime()) || day(date) !== value) throw new Error("Enter a valid calendar date.");
    return value;
  }
  function shifted(now, days) {
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() + days);
    if (!Number.isFinite(date.getTime()) || date.getFullYear() < 1e3 || date.getFullYear() > 9999) throw new Error("Date is outside the supported range.");
    return day(date);
  }
  function parseTime(input) {
    const result = /^(\d{1,2})(?:[:.](\d{2}))?$/.exec(input.trim());
    if (!result || Number(result[1]) > 23 || Number(result[2] || 0) > 59) throw new Error("Use a valid time such as 9, 09:40 or 9.40.");
    return `${result[1].padStart(2, "0")}:${result[2] || "00"}:00`;
  }
  function durationSeconds(input) {
    const parsed = /^(?:(\d+)h)?(?:(\d+)m)?$/i.exec(input.trim());
    if (!parsed || !parsed[1] && !parsed[2]) throw new Error("Use a duration such as 45m or 1h20m.");
    const seconds = Number(parsed[1] || 0) * 3600 + Number(parsed[2] || 0) * 60;
    if (!Number.isSafeInteger(seconds)) throw new Error("Duration is too large.");
    return seconds;
  }
  function parseWork(input, date, start, now = /* @__PURE__ */ new Date()) {
    const calendar = resolveDate(date, now);
    if (input.includes("-")) {
      const times = input.split("-");
      if (times.length !== 2) throw new Error("Use an interval such as 09:40-11:00.");
      const startTime2 = parseTime(times[0]), endTime2 = parseTime(times[1]);
      const from = /* @__PURE__ */ new Date(`${calendar}T${startTime2}`), to = /* @__PURE__ */ new Date(`${calendar}T${endTime2}`);
      if (endTime2 <= startTime2) to.setDate(to.getDate() + 1);
      const timeSpentSeconds = (to.getTime() - from.getTime()) / 1e3;
      if (timeSpentSeconds <= 0) throw new Error("Interval has no elapsed time in this timezone.");
      return { startTime: startTime2, timeSpentSeconds };
    }
    const seconds = durationSeconds(input);
    if (seconds <= 0) throw new Error("Worked time must be greater than zero.");
    const defaultStart = calendar === day(now) ? `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}` : "00:00";
    const startTime = !start?.trim() && calendar === day(now) ? `${defaultStart}:${String(now.getSeconds()).padStart(2, "0")}` : parseTime(start?.trim() || defaultStart);
    return { timeSpentSeconds: seconds, startTime };
  }
  function parseEstimate(input) {
    return input.trim() ? durationSeconds(input) : void 0;
  }
  function duration(seconds) {
    const minutes = Math.floor(Math.abs(seconds) / 60), hours = Math.floor(minutes / 60);
    return `${seconds < 0 && minutes > 0 ? "-" : ""}${hours ? `${hours}h` : ""}${minutes % 60 ? `${minutes % 60}m` : hours ? "" : "0h"}`;
  }
  function resolveIssue(input, aliases) {
    const value = input.trim();
    const key2 = (Object.hasOwn(aliases, value) ? aliases[value] : value).toUpperCase();
    if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key2)) throw new Error("Enter an issue key such as NOVA-318 or a saved alias.");
    return key2;
  }
  function startTracker(issueKey, description, now) {
    return { issueKey: resolveIssue(issueKey, {}), description, activeSince: now, intervals: [] };
  }
  function pauseTracker(tracker, now) {
    const next = structuredClone(tracker);
    if (next.activeSince !== null) {
      if (now < next.activeSince) throw new Error("The clock moved backwards. Resume after correcting the clock.");
      if (now - next.activeSince >= 6e4) next.intervals.push({ id: crypto.randomUUID(), start: next.activeSince, end: now });
      next.activeSince = null;
    }
    return next;
  }
  function resumeTracker(tracker, now) {
    return { ...structuredClone(tracker), activeSince: tracker.activeSince ?? now };
  }
  function trackerSeconds(tracker, now) {
    return tracker.intervals.reduce((sum, i) => sum + Math.floor((i.end - i.start) / 6e4) * 60, 0) + (tracker.activeSince === null ? 0 : Math.max(0, Math.floor((now - tracker.activeSince) / 6e4) * 60));
  }
  function trackerWorklogs(tracker) {
    return tracker.intervals.filter((i) => i.end - i.start >= 6e4).map((i) => {
      const date = new Date(i.start);
      return { intervalId: i.id, date: day(date), startTime: `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:00`, timeSpentSeconds: Math.floor((i.end - i.start) / 6e4) * 60 };
    });
  }

  // src/store.ts
  var key = `tempo:v1:${location.hostname}`;
  function readState() {
    const state = GM_getValue(key, { version: 1, aliases: {}, trackers: {} });
    if (state.version !== 1 || !state.aliases || !state.trackers) throw new Error("Stored data is not compatible with this version.");
    return structuredClone(state);
  }
  function subscribe(listener) {
    GM_addValueChangeListener(key, listener);
  }
  async function transaction(action) {
    if (!navigator.locks) throw new Error("This browser does not support safe multi-tab writes. Please update your browser.");
    return navigator.locks.request(key, async () => {
      const state = await GM.getValue(key, { version: 1, aliases: {}, trackers: {} });
      if (state.version !== 1 || !state.aliases || !state.trackers) throw new Error("Stored data is not compatible with this version.");
      return action(state, () => GM.setValue(key, structuredClone(state)));
    });
  }

  // src/styles.ts
  var styles = `
:host { all: initial; font: 14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color: #172b4d; color-scheme: light; }
* { box-sizing: border-box; } [hidden] { display: none !important; }
button,input,textarea { font: inherit; } button { cursor: pointer; border: 1px solid #ced7e3; border-radius: 5px; background: #f7f9fc; color: #172b4d; padding: 8px 12px; }
button:hover { background: #edf2f7; } button:disabled { cursor: wait; opacity: .6; }
button:focus-visible,input:focus-visible,textarea:focus-visible,a:focus-visible { outline: 2px solid #0d9488; outline-offset: 2px; }
.launcher { position: fixed; right: 0; top: 50%; transform: translateY(-50%); background: #0d9488; color: white; border: 0; border-radius: 24px 0 0 24px; padding: 13px 18px; font-weight: 650; box-shadow: 0 6px 24px #172b4d33; }
.launcher:hover,.primary:hover { background: #0b7b72; }
.panel { position: fixed; top: 18px; right: 18px; bottom: 18px; width: 540px; max-width: calc(100vw - 36px); background: #fff; border: 1px solid #dce3ed; border-radius: 9px; box-shadow: 0 14px 65px #172b4d38; display: flex; flex-direction: column; overflow: hidden; }
header { padding: 16px 22px 12px; display: flex; justify-content: space-between; align-items: flex-start; }
h1 { font-size: 23px; line-height: 1.3; margin: 0; letter-spacing: -.6px; } h2 { margin: 22px 0 14px; font-size: 18px; } p { margin: 4px 0 14px; } .muted,small { color: #62758d; } small { font-size: 12px; }
.close { background: none; border: 0; font-size: 23px; padding: 0 3px; }
nav { display: flex; padding: 0 22px; border-bottom: 1px solid #dce3ed; } nav button { flex: 1; border: 0; border-radius: 0; background: #fff; padding: 11px 4px; border-bottom: 2px solid transparent; }
nav button[aria-selected=true] { color: #0d9488; border-bottom-color: #0d9488; font-weight: 650; }
main { padding: 12px 22px 20px; overflow-y: auto; overscroll-behavior: contain; flex: 1; }
.status { margin: 0 22px 10px; padding: 9px 12px; border-radius: 5px; background: #e8f6f3; color: #156a54; white-space: pre-line; overflow-wrap: anywhere; } .status:empty { display: none; } .status.error { background: #fff0ed; color: #a73525; }
.row { display: flex; gap: 10px; align-items: center; } .row > input,.row > label { flex: 1; min-width: 0; } .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; } .grid > label { min-width: 0; }
label { display: block; font-weight: 600; font-size: 13px; margin-bottom: 13px; } input,textarea { display: block; width: 100%; margin-top: 5px; border: 1px solid #bac7d8; border-radius: 4px; padding: 9px 11px; background: #fff; color: #172b4d; font-weight: 400; min-height: 40px; } input[type=checkbox] { display: inline; width: auto; min-height: 0; margin: 0 6px 0 0; } textarea { resize: vertical; min-height: 64px; } .check { font-weight: 400; }
.primary { background: #0d9488; border-color: #0d9488; color: white; font-weight: 600; } .wide { width: 100%; } .danger { color: #b42318; } .small { font-size: 12px; padding: 4px 8px; }
.summary { margin: 10px 0 12px; line-height: 1.7; } .summary strong { font-variant-numeric: tabular-nums; }
.table-wrap { overflow-x: auto; } table { border-collapse: collapse; width: 100%; font-size: 13px; } th { background: #f4f6fa; font-weight: 600; text-align: left; } th,td { padding: 10px 8px; border-bottom: 1px solid #dce3ed; vertical-align: top; } a { color: #1264a3; text-decoration: none; } a:hover { text-decoration: underline; } td p { margin: 4px 0; overflow-wrap: anywhere; font-size: 12px; } .nowrap { white-space: nowrap; } .empty { color: #62758d; padding: 20px 0; }
hr { border: 0; border-top: 1px solid #dce3ed; margin: 22px 0 0; } .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; } .tracker { padding: 15px 0; border-bottom: 1px solid #dce3ed; } .tracker-title { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; } .tracker-title strong { font-size: 16px; } details { margin-top: 8px; } summary { cursor: pointer; color: #62758d; }
@media(max-width: 560px) { .panel { inset: 0; width: 100%; max-width: 100%; border-radius: 0; } header { padding: 16px; } nav { padding: 0 12px; } main { padding: 16px; } .status { margin: 0 16px 8px; } .grid { gap: 10px; } th,td { padding: 8px 5px; } }
`;

  // src/main.ts
  if (!document.getElementById("tempo-userscript")) mount();
  function mount() {
    const host = document.createElement("div");
    host.id = "tempo-userscript";
    host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483000";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${styles}
.launcher,.panel{pointer-events:auto}</style>
    <button class="launcher" aria-label="Open Tempo">Tempo</button>
    <section class="panel" hidden aria-label="Tempo panel">
      <header><div><h1>Tempo</h1><span class="muted">Work without the tab switching</span></div><button class="close" aria-label="Close Tempo">×</button></header>
      <nav role="tablist" aria-label="Tempo navigation">${["Worklogs", "Trackers", "Aliases", "Settings"].map((t) => `<button role="tab" data-tab="${t}">${t}</button>`).join("")}</nav>
      <div class="status" role="status" aria-live="polite"></div><main></main>
    </section>`;
    document.body.append(host);
    const panel = root.querySelector(".panel");
    const main = root.querySelector("main");
    const status = root.querySelector(".status");
    const launcher = root.querySelector(".launcher");
    let tab = readState().credentials ? "Worklogs" : "Settings";
    let busy = false;
    let loaded = false;
    let selectedDate = resolveDate("");
    let logs = [];
    let schedule = [];
    const issueKeys = /* @__PURE__ */ new Map();
    const selected = /* @__PURE__ */ new Set();
    const drafts = { date: selectedDate };
    let verbose = false;
    function notice(message, error = false) {
      status.textContent = message;
      status.classList.toggle("error", error);
    }
    function open() {
      panel.hidden = false;
      launcher.hidden = true;
      if (!drafts.issue) drafts.issue = currentIssue();
      render();
      root.querySelector(`[data-tab="${tab}"]`)?.focus();
      if (tab === "Worklogs" && !loaded) void run(refresh);
    }
    function close() {
      panel.hidden = true;
      launcher.hidden = false;
      launcher.focus();
    }
    launcher.onclick = open;
    root.querySelector(".close").onclick = close;
    GM_registerMenuCommand("Open Tempo", open);
    root.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
    });
    root.querySelector("nav").addEventListener("click", (e) => {
      const button2 = e.target.closest("[data-tab]");
      if (!button2 || busy) return;
      tab = button2.dataset.tab;
      notice("");
      render();
      if (tab === "Worklogs" && !loaded && readState().credentials) void run(refresh);
    });
    main.addEventListener("input", (e) => {
      const input = e.target;
      if (input.name && input.type !== "checkbox") drafts[input.name] = input.value;
    });
    main.addEventListener("change", (e) => {
      const input = e.target;
      if (input.dataset.select) {
        if (input.checked) selected.add(input.dataset.select);
        else selected.delete(input.dataset.select);
      }
      if (input.name === "verbose") {
        verbose = input.checked;
        render();
      }
    });
    main.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = e.target.dataset.form;
      if (name) void run(() => submit(name));
    });
    main.addEventListener("click", (e) => {
      const button2 = e.target.closest("button[data-action]");
      if (button2) void run(() => action(button2.dataset.action, button2.dataset.id));
    });
    subscribe(() => {
      if (!busy && !panel.hidden && (tab === "Trackers" || tab === "Aliases")) render();
    });
    setInterval(() => {
      if (panel.hidden || tab !== "Trackers") return;
      const state = readState();
      for (const node of root.querySelectorAll("[data-duration]")) {
        const tracker = state.trackers[node.dataset.duration];
        if (tracker) node.textContent = duration(trackerSeconds(tracker, Date.now()));
      }
    }, 1e3);
    async function run(task) {
      if (busy) return;
      busy = true;
      notice("Working…");
      root.querySelectorAll("main button, nav button").forEach((b) => {
        b.disabled = true;
      });
      main.setAttribute("aria-busy", "true");
      try {
        await task();
      } catch (error) {
        notice(error instanceof Error ? error.message : "Something went wrong.", true);
      } finally {
        busy = false;
        render();
        main.removeAttribute("aria-busy");
      }
    }
    function credentials(state = readState()) {
      if (!state.credentials) throw new Error("Open Settings and connect your Jira and Tempo accounts first.");
      if (state.credentials.hostname !== location.hostname) throw new Error("Credentials belong to a different Jira site. Connect this site in Settings.");
      return state.credentials;
    }
    async function refresh() {
      const api = createApi(credentials());
      const date = resolveDate(drafts.date || "");
      const [year, month] = date.split("-").map(Number);
      const from = `${date.slice(0, 7)}-01`;
      const to = `${date.slice(0, 7)}-${new Date(year, month, 0).getDate()}`;
      const [items, days] = await Promise.all([api.getWorklogs(from, to), api.getSchedule(from, to)]);
      const needed = [...new Set(items.filter((w) => w.startDate === date).map((w) => w.issueId))].filter((id) => !issueKeys.has(id));
      let cursor = 0;
      const workers = Array.from({ length: Math.min(4, needed.length) }, async () => {
        while (cursor < needed.length) {
          const id = needed[cursor++];
          try {
            issueKeys.set(id, await api.getIssueKey(id));
          } catch {
          }
        }
      });
      await Promise.all(workers);
      logs = items;
      schedule = days;
      selectedDate = date;
      drafts.date = date;
      loaded = true;
      selected.clear();
      notice("Worklogs refreshed.");
    }
    async function submit(name) {
      if (name === "settings") {
        await transaction(async (state, save) => {
          const input = {
            hostname: location.hostname,
            email: drafts.email?.trim() || state.credentials?.email || "",
            jiraToken: drafts.jiraToken?.trim() || state.credentials?.jiraToken || ""
          };
          const tempoToken = drafts.tempoToken?.trim() || state.credentials?.tempoToken || "";
          if (!tempoToken) throw new Error("Enter a Tempo API token.");
          const identity = await discoverAccount(input);
          const next = { ...input, tempoToken, accountId: identity.accountId };
          const today = resolveDate("");
          await createApi(next).getSchedule(today, today);
          if (Object.keys(state.trackers).length && state.credentials?.accountId !== next.accountId) throw new Error("Finish or delete your local trackers before switching accounts.");
          state.credentials = next;
          await save();
          drafts.jiraToken = "";
          drafts.tempoToken = "";
          loaded = false;
          logs = [];
          schedule = [];
          issueKeys.clear();
          notice(`Connected as ${identity.displayName || identity.accountId}.`);
        });
      } else if (name === "worklog") {
        await transaction(async (state) => {
          const issue = resolveIssue(drafts.issue || "", state.aliases);
          const date = resolveDate(drafts.date || "");
          const parsed = parseWork(drafts.work || "", date, drafts.start);
          const remainingEstimateSeconds = parseEstimate(drafts.estimate || "");
          const api = createApi(credentials(state));
          const issueId = await api.getIssueId(issue);
          const result = await api.addWorklog({ issueId, ...parsed, startDate: date, description: drafts.description || "", remainingEstimateSeconds });
          drafts.work = "";
          drafts.description = "";
          loaded = false;
          notice(`Saved ${duration(parsed.timeSpentSeconds)} to ${issue}. Worklog #${result.id}.`);
        });
        const message = status.textContent;
        try {
          await refresh();
          notice(message);
        } catch {
          notice(`${message} Refresh failed; try Refresh before submitting again.`);
        }
      } else if (name === "alias") {
        await transaction(async (state, save) => {
          const alias = (drafts.alias || "").trim();
          if (!/^[a-zA-Z0-9_-]{1,40}$/.test(alias) || ["__proto__", "constructor", "prototype"].includes(alias)) throw new Error("Use 1–40 letters, numbers, dashes or underscores for the alias.");
          state.aliases[alias] = resolveIssue(drafts.aliasIssue || "", {});
          await save();
          notice(`Saved alias ${alias}.`);
        });
      } else if (name === "tracker") {
        const stopPrevious = main.querySelector('[name="stopPrevious"]')?.checked;
        await transaction(async (state, save) => {
          const issue = resolveIssue(drafts.trackerIssue || currentIssue(), state.aliases);
          if (state.trackers[issue]) {
            if (!stopPrevious) throw new Error("A tracker already exists for this issue. Resume it, or select Stop previous.");
            await uploadTracker(state, save, issue);
          }
          state.trackers[issue] = startTracker(issue, drafts.trackerDescription || "", Date.now());
          await save();
          notice(`Started ${issue}.`);
        });
      }
    }
    async function uploadTracker(state, save, key2) {
      const existing = state.trackers[key2];
      if (!existing) throw new Error("This tracker no longer exists. Refresh the panel.");
      const estimate = parseEstimate(drafts.trackerEstimate || "");
      const tracker = pauseTracker(existing, Date.now());
      state.trackers[key2] = tracker;
      await save();
      const intervals = trackerWorklogs(tracker);
      if (!intervals.length) {
        delete state.trackers[key2];
        await save();
        notice(`Removed ${key2}: no intervals of at least one minute.`);
        return;
      }
      const api = createApi(credentials(state));
      const issueId = await api.getIssueId(key2);
      let failed = 0;
      for (const interval of intervals) {
        try {
          await api.addWorklog({
            issueId,
            startDate: interval.date,
            startTime: interval.startTime,
            timeSpentSeconds: interval.timeSpentSeconds,
            description: drafts.stopDescription || tracker.description,
            remainingEstimateSeconds: estimate
          });
        } catch {
          failed++;
          continue;
        }
        tracker.intervals = tracker.intervals.filter((i) => i.id !== interval.intervalId);
        await save();
      }
      loaded = false;
      if (failed) throw new Error(`${failed} interval(s) failed and remain paused. Check Tempo before retrying if a request timed out.`);
      delete state.trackers[key2];
      await save();
      notice(`Logged all intervals for ${key2}.`);
    }
    async function action(name, id) {
      if (name === "refresh") return refresh();
      if (name === "current") {
        drafts.issue = currentIssue();
        notice(drafts.issue ? "Current issue selected." : "Open a Jira issue to use this shortcut.");
        return;
      }
      if (name === "delete" || name === "delete-selected") {
        const ids = id ? [id] : [...selected];
        if (!ids.length) {
          notice("Select worklogs to delete.");
          return;
        }
        if (!window.confirm(`Delete ${ids.length} Tempo worklog(s)? This cannot be undone.`)) {
          notice("Deletion cancelled.");
          return;
        }
        await transaction(async (state) => {
          const api = createApi(credentials(state));
          const failed = [];
          for (const value of ids) {
            try {
              await api.deleteWorklog(value);
              logs = logs.filter((w) => w.id !== value);
              selected.delete(value);
            } catch {
              failed.push(value);
            }
          }
          notice(failed.length ? `Could not delete: ${failed.join(", ")}. Other selected worklogs were deleted.` : `Deleted ${ids.length} worklog(s).`, !!failed.length);
        });
        return;
      }
      if (name === "disconnect") {
        if (!window.confirm("Remove saved credentials for this Jira site? Aliases and trackers will be kept.")) {
          notice("Cancelled.");
          return;
        }
        await transaction(async (state, save) => {
          delete state.credentials;
          await save();
        });
        drafts.email = "";
        drafts.jiraToken = "";
        drafts.tempoToken = "";
        loaded = false;
        logs = [];
        schedule = [];
        issueKeys.clear();
        notice("Credentials removed.");
        return;
      }
      await transaction(async (state, save) => {
        if (!id) return;
        if (name === "alias-delete") {
          delete state.aliases[id];
          await save();
          notice(`Deleted alias ${id}.`);
          return;
        }
        const tracker = state.trackers[id];
        if (!tracker) throw new Error("This tracker no longer exists.");
        if (name === "pause") state.trackers[id] = pauseTracker(tracker, Date.now());
        else if (name === "resume") state.trackers[id] = resumeTracker(tracker, Date.now());
        else if (name === "stop") {
          await uploadTracker(state, save, id);
          return;
        } else if (name === "tracker-delete") {
          if (!window.confirm(`Discard local tracker ${id} without uploading?`)) {
            notice("Cancelled.");
            return;
          }
          delete state.trackers[id];
        }
        await save();
        notice("Tracker updated.");
      });
    }
    function field(name, label, placeholder = "", type = "text", fallback = "") {
      return `<label>${label}<input name="${name}" type="${type}" value="${escape(drafts[name] ?? fallback)}" placeholder="${escape(placeholder)}" autocomplete="off" ${type === "password" ? 'data-lpignore="true"' : ""}></label>`;
    }
    function button(action2, text, id, style = "") {
      return `<button type="button" class="${style}" data-action="${action2}" ${id ? `data-id="${escape(id)}"` : ""}>${text}</button>`;
    }
    function render() {
      const state = readState();
      root.querySelectorAll("[data-tab]").forEach((b) => {
        b.setAttribute("aria-selected", String(b.dataset.tab === tab));
        b.disabled = busy;
      });
      if (tab === "Settings") {
        main.innerHTML = `<h2 style="margin-top:0">Connect your accounts</h2><p class="muted">${escape(location.hostname)}</p>
      <form data-form="settings">${field("email", "Jira email", "you@example.com", "email", state.credentials?.email || "")}
      ${field("jiraToken", "Jira API token", state.credentials ? "Leave blank to keep saved token" : "API token without scopes", "password")}
      ${field("tempoToken", "Tempo API token", state.credentials ? "Leave blank to keep saved token" : "Tempo Settings → API integration", "password")}
      <p class="muted">Your account ID is discovered automatically. Tokens stay in Tampermonkey storage on this browser.</p>
      <button class="primary wide" type="submit">${state.credentials ? "Verify & save" : "Connect accounts"}</button></form>
      ${state.credentials ? `<p style="margin-top:14px"><small>Connected account: ${escape(state.credentials.accountId)}</small></p>${button("disconnect", "Remove credentials", void 0, "danger")}` : ""}
      <hr><p style="margin-top:16px"><a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noopener noreferrer">Create a Jira token</a></p>
      <small>Use an Atlassian API token without scopes. Scoped tokens require a different Jira gateway and are not supported by this version.</small>`;
      } else if (tab === "Aliases") {
        main.innerHTML = `<h2 style="margin-top:0">Issue shortcuts</h2><p class="muted">Use aliases in worklogs and trackers.</p>
      ${Object.entries(state.aliases).length ? `<table><thead><tr><th>Alias</th><th>Issue</th><th></th></tr></thead><tbody>${Object.entries(state.aliases).map(([name, key2]) => `<tr><td>${escape(name)}</td><td>${escape(key2)}</td><td>${button("alias-delete", "Delete", name, "small danger")}</td></tr>`).join("")}</tbody></table>` : '<p class="empty">No aliases yet.</p>'}
      <hr><h2>Add an alias</h2><form data-form="alias">${field("alias", "Alias", "review")}${field("aliasIssue", "Issue key", "NOVA-318")}<button type="submit" class="primary wide">Save alias</button></form>`;
      } else if (tab === "Trackers") {
        main.innerHTML = `<p class="muted">Track locally. Stop to submit each work interval to Tempo.</p>
      ${Object.values(state.trackers).length ? Object.values(state.trackers).map((tracker) => renderTracker(tracker)).join("") : '<p class="empty">No trackers yet.</p>'}
      <h2>Stop options</h2>${field("stopDescription", "Override description (optional)")}${field("trackerEstimate", "Remaining estimate (optional)", "2h")}
      <hr><h2>Start a tracker</h2><form data-form="tracker">${field("trackerIssue", "Issue or alias", "NOVA-318", "text", currentIssue())}${field("trackerDescription", "Description")}
      <label class="check"><input type="checkbox" name="stopPrevious">Stop and log the previous tracker for this issue</label><button type="submit" class="primary wide">Start tracker</button></form>`;
      } else {
        const dayLogs = logs.filter((w) => w.startDate === selectedDate).sort((a, b) => a.startTime.localeCompare(b.startTime));
        const sum = (items) => items.reduce((n, w) => n + w.timeSpentSeconds, 0);
        const required = schedule.reduce((n, d) => n + d.requiredSeconds, 0);
        const today = resolveDate("");
        const delta = sum(logs) - schedule.filter((d) => d.date <= today).reduce((n, d) => n + d.requiredSeconds, 0);
        main.innerHTML = `<div class="row"><input aria-label="Worklog date" name="date" value="${escape(drafts.date)}" placeholder="YYYY-MM-DD or yesterday">${button("refresh", "Refresh")}</div>
      ${loaded ? `<div class="summary">Month ${selectedDate.slice(0, 7)}: <strong>${duration(sum(logs))} / ${duration(required)}</strong> <span class="muted">(${delta >= 0 ? "+" : ""}${duration(delta)})</span><br>Selected day: <strong>${duration(sum(dayLogs))} / ${duration(schedule.find((d) => d.date === selectedDate)?.requiredSeconds || 0)}</strong></div>` : '<p class="empty">Connect in Settings, then refresh your worklogs.</p>'}
      <label class="check"><input type="checkbox" name="verbose" ${verbose ? "checked" : ""}>Show descriptions & worklog IDs</label>
      <div class="table-wrap"><table><thead><tr><th></th><th>Time</th><th>Issue</th><th>Duration</th><th></th></tr></thead><tbody>
      ${dayLogs.map((w) => `<tr><td><input type="checkbox" aria-label="Select worklog ${escape(w.id)}" data-select="${escape(w.id)}" ${selected.has(w.id) ? "checked" : ""}></td><td class="nowrap">${escape(w.startTime.slice(0, 5))}–${endTime(w)}</td><td><a target="_blank" rel="noopener noreferrer" href="https://${location.hostname}/browse/${encodeURIComponent(issueKeys.get(w.issueId) || w.issueId)}">${escape(issueKeys.get(w.issueId) || `#${w.issueId}`)}</a>${aliasLabels(state, w)}${verbose ? `<p>${escape(w.description)}</p><small>#${escape(w.id)}</small>` : ""}</td><td>${duration(w.timeSpentSeconds)}</td><td>${button("delete", "Delete", w.id, "small danger")}</td></tr>`).join("")}
      </tbody></table></div>${loaded && !dayLogs.length ? '<p class="empty">No worklogs for this day.</p>' : ""}
      ${dayLogs.length ? `<div class="actions">${button("delete-selected", "Delete selected", void 0, "small danger")}</div>` : ""}
      <hr><h2>Log work</h2><form data-form="worklog"><div class="row">${field("issue", "Issue or alias", "NOVA-318", "text", currentIssue())}
      ${button("current", "Use current issue", void 0, "small")}</div><div class="grid">${field("work", "Duration or interval", "1h20m or 09:40-11:00")}${field("start", "Start time (optional)", "09:40")}</div>
      <label>Description<textarea name="description">${escape(drafts.description || "")}</textarea></label>${field("estimate", "Remaining estimate (optional)", "2h")}
      <button class="primary wide" type="submit">Save worklog</button></form>`;
      }
    }
    function aliasLabels(state, w) {
      const names = Object.entries(state.aliases).filter(([, key2]) => key2 === issueKeys.get(w.issueId)).map(([name]) => name);
      return names.length ? `<p class="muted">${escape(names.join(", "))}</p>` : "";
    }
    function renderTracker(tracker) {
      const key2 = tracker.issueKey;
      return `<article class="tracker"><div class="tracker-title"><strong>${escape(key2)}</strong><span data-duration="${escape(key2)}">${duration(trackerSeconds(tracker, Date.now()))}</span></div>
    <small>${tracker.activeSince === null ? "Paused" : "Running"}</small><p>${escape(tracker.description)}</p>
    <div class="actions">${button(tracker.activeSince === null ? "resume" : "pause", tracker.activeSince === null ? "Resume" : "Pause", key2)}${button("stop", "Stop & log", key2, "primary")}${button("tracker-delete", "Discard", key2, "danger")}</div>
    <details><summary>${tracker.intervals.length} saved interval(s)</summary>${tracker.intervals.map((i) => `<p><small>${escape(new Date(i.start).toLocaleString())} → ${escape(new Date(i.end).toLocaleString())} · ${duration(Math.floor((i.end - i.start) / 6e4) * 60)}</small></p>`).join("")}</details></article>`;
    }
  }
  function escape(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }
  function currentIssue() {
    const url = new URL(location.href);
    const candidate = url.searchParams.get("selectedIssue") || url.pathname.match(/\/browse\/([A-Za-z][\w]*-\d+)/)?.[1] || "";
    return /^[a-zA-Z][\w]*-\d+$/.test(candidate) ? candidate.toUpperCase() : "";
  }
  function endTime(worklog) {
    const date = /* @__PURE__ */ new Date(`${worklog.startDate}T${worklog.startTime || "00:00:00"}`);
    date.setTime(date.getTime() + worklog.timeSpentSeconds * 1e3);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
})();
