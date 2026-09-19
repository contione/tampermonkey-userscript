// Tampermonkey metadata must include: // @grant GM_xmlhttpRequest

export type HttpMethod = 'GET' | 'POST' | 'DELETE'
export type RedirectMode = 'error' | 'follow' | 'manual'

export type TransportRequest = {
    method: HttpMethod
    url: string
    headers: Record<string, string>
    body?: string
    timeoutMs: number
    anonymous: boolean
    redirect: RedirectMode
}

export type TransportResponse = {
    status: number
    responseText?: string
    responseHeaders?: string | Record<string, string>
    finalUrl?: string
}

export type Transport = (request: TransportRequest) => Promise<TransportResponse>

export type RequestJsonOptions = {
    method?: HttpMethod
    headers?: Record<string, string>
    body?: unknown
    timeoutMs?: number
    transport?: Transport
    allowedOrigin?: string
}

export type HttpResponse<T> = {
    status: number
    data: T
    headers: string | Record<string, string> | undefined
    url: string
}

export class HttpError extends Error {
    readonly method: HttpMethod
    readonly status?: number
    readonly data?: unknown
    readonly responseHeaders?: string | Record<string, string>

    constructor(
        message: string,
        options: {
            method: HttpMethod
            status?: number
            data?: unknown
            responseHeaders?: string | Record<string, string>
            cause?: unknown
        }
    ) {
        super(message, { cause: options.cause })
        this.name = 'HttpError'
        this.method = options.method
        this.status = options.status
        this.data = options.data
        this.responseHeaders = options.responseHeaders
    }
}

export const DEFAULT_TIMEOUT_MS = 15_000
const MAX_GET_RETRIES = 2
const MAX_RETRY_WAIT_MS = DEFAULT_TIMEOUT_MS
const INITIAL_RETRY_WAIT_MS = 250

type GMRequestDetails = {
    method: HttpMethod
    url: string
    headers?: Record<string, string>
    data?: string
    timeout?: number
    anonymous?: boolean
    redirect?: RedirectMode
    onload?: (response: GMResponse) => void
    onerror?: () => void
    ontimeout?: () => void
    onabort?: () => void
}

type GMResponse = {
    status: number
    responseText?: string
    responseHeaders?: string
    finalUrl?: string
}

declare const GM_xmlhttpRequest: (details: GMRequestDetails) => { abort(): void }

export const gmTransport: Transport = request => new Promise((resolve, reject) => {
    let handle: { abort(): void } | undefined
    const timer = setTimeout(() => {
        reject(new HttpError('Request timed out. Check Tempo before retrying a write.', { method: request.method }))
        handle?.abort()
    }, request.timeoutMs)
    const fail = (message: string) => { clearTimeout(timer); reject(new HttpError(message, { method: request.method })) }
    try {
        handle = GM_xmlhttpRequest({
            method: request.method,
            url: request.url,
            headers: request.headers,
            data: request.body,
            timeout: request.timeoutMs,
            anonymous: true,
            redirect: 'error',
            onload: response => { clearTimeout(timer); resolve({
                status: response.status,
                responseText: response.responseText,
                responseHeaders: response.responseHeaders,
                finalUrl: response.finalUrl
            }) },
            onerror: () => fail('Network request failed. Check your connection and token permissions.'),
            ontimeout: () => fail('Request timed out. Check Tempo before retrying a write.'),
            onabort: () => fail('Request aborted.')
        })
    } catch (error) {
        clearTimeout(timer)
        reject(error)
    }
})

export async function requestJson<T>(urlInput: string | URL, options: RequestJsonOptions = {}): Promise<HttpResponse<T>> {
    const method = options.method ?? 'GET'
    const url = new URL(urlInput.toString())
    const allowedOrigin = options.allowedOrigin
    if (allowedOrigin) assertSameOrigin(url, allowedOrigin)

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error('HTTP timeout must be a positive number.')
    }

    const body = options.body === undefined
        ? undefined
        : typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
    const headers: Record<string, string> = {
        Accept: 'application/json',
        ...options.headers,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    }
    const transport = options.transport ?? gmTransport

    for (let retry = 0; ; retry += 1) {
        let response: TransportResponse
        try {
            response = await withTimeout(transport({
                method,
                url: url.toString(),
                headers,
                body,
                timeoutMs,
                anonymous: true,
                redirect: 'error'
            }), timeoutMs, method)
        } catch (error) {
            if (error instanceof HttpError) throw error
            throw new HttpError('Network request failed.', { method, cause: error })
        }

        if (response.finalUrl) {
            const finalUrl = new URL(response.finalUrl)
            if (finalUrl.origin !== url.origin) {
                throw new HttpError('Request redirected to another origin.', { method })
            }
        }

        const data = parseBody(response.responseText)
        if (response.status >= 200 && response.status < 300) {
            return {
                status: response.status,
                data: data as T,
                headers: response.responseHeaders,
                url: response.finalUrl ?? url.toString()
            }
        }

        const error = new HttpError(`HTTP ${response.status}`, {
            method,
            status: response.status,
            data,
            responseHeaders: response.responseHeaders
        })
        if (method !== 'GET' || retry >= MAX_GET_RETRIES || !isRetryable(response.status)) {
            throw error
        }

        const waitMs = retryWait(response.responseHeaders, retry)
        if (waitMs === undefined || waitMs > MAX_RETRY_WAIT_MS) throw error
        await delay(waitMs)
    }
}

export function assertSameOrigin(url: URL, allowedOrigin: string): void {
    const expectedOrigin = new URL(allowedOrigin).origin
    if (url.origin !== expectedOrigin) {
        throw new HttpError('Request origin is not allowed.', { method: 'GET' })
    }
}

function parseBody(body: string | undefined): unknown {
    if (!body || !body.trim()) return undefined
    try {
        return JSON.parse(body) as unknown
    } catch {
        return body
    }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, method: HttpMethod): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new HttpError('Request timed out.', { method })), timeoutMs)
        promise.then(resolve, reject).finally(() => clearTimeout(timer))
    })
}

function isRetryable(status: number): boolean {
    return status === 429 || (status >= 500 && status <= 599)
}

function retryWait(headers: string | Record<string, string> | undefined, retry: number): number | undefined {
    const retryAfter = getHeader(headers, 'retry-after')
    if (retryAfter) {
        const seconds = Number(retryAfter.trim())
        if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000)
        const retryAt = Date.parse(retryAfter)
        if (Number.isFinite(retryAt)) return Math.max(0, retryAt - Date.now())
        return undefined
    }
    return Math.min(INITIAL_RETRY_WAIT_MS * (2 ** retry), MAX_RETRY_WAIT_MS)
}

function getHeader(headers: string | Record<string, string> | undefined, name: string): string | undefined {
    if (!headers) return undefined
    if (typeof headers !== 'string') {
        const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === name.toLowerCase())
        return key ? headers[key] : undefined
    }
    const line = headers.split(/\r?\n/).find(value => value.toLowerCase().startsWith(`${name.toLowerCase()}:`))
    return line?.slice(line.indexOf(':') + 1).trim()
}

function delay(milliseconds: number): Promise<void> {
    if (milliseconds <= 0) return Promise.resolve()
    return new Promise(resolve => setTimeout(resolve, milliseconds))
}
