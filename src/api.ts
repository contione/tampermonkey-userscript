import {
    gmTransport,
    HttpError,
    type HttpMethod,
    type Transport,
    requestJson
} from './http'

export type Credentials = {
    hostname: string
    email: string
    jiraToken: string
    tempoToken: string
    accountId: string
}

export type Identity = {
    accountId: string
    displayName: string
}

export type Worklog = {
    id: string
    issueId: string
    startDate: string
    startTime: string
    timeSpentSeconds: number
    description: string
}

export type DaySchedule = {
    date: string
    requiredSeconds: number
    type: string
}

export type AddWorklog = {
    issueId: string
    timeSpentSeconds: number
    startDate: string
    startTime: string
    description?: string
    remainingEstimateSeconds?: number
}

export type DiscoverAccountInput = {
    hostname: string
    email: string
    jiraToken: string
}

export type TempoApi = {
    getIssueId(issueKey: string): Promise<string>
    getIssueKey(issueId: string): Promise<string>
    addWorklog(input: AddWorklog): Promise<Worklog>
    getWorklog(id: string): Promise<Worklog>
    deleteWorklog(id: string): Promise<void>
    getWorklogs(from: string, to: string): Promise<Worklog[]>
    getSchedule(from: string, to: string): Promise<DaySchedule[]>
}

const TEMPO_ORIGIN = 'https://api.tempo.io'
const TEMPO_API_ORIGIN = `${TEMPO_ORIGIN}/4`

export async function discoverAccount(
    input: DiscoverAccountInput,
    transport: Transport = gmTransport
): Promise<Identity> {
    const origin = normalizeAtlassianOrigin(input.hostname)
    const email = requireText(input.email, 'Jira email')
    const jiraToken = requireText(input.jiraToken, 'Jira token')

    try {
        const response = await requestJson<unknown>(`${origin}/rest/api/3/myself`, {
            transport,
            allowedOrigin: origin,
            headers: { Authorization: `Basic ${basicAuth(email, jiraToken)}` }
        })
        return parseIdentity(response.data)
    } catch (error) {
        throw toApiError('Jira', error)
    }
}

export function createApi(credentials: Credentials, transport: Transport = gmTransport): TempoApi {
    const config = normalizeCredentials(credentials)

    return {
        getIssueId: issueKey => execute('Jira', () => jiraJson<unknown>(
            `/issue/${encodeURIComponent(requireText(issueKey, 'Issue key'))}`,
            config,
            transport
        ).then(response => {
            if (!isRecord(response.data)) throw new Error('Jira issue response is invalid.')
            return normalizeId(response.data.id, 'Jira issue id')
        })),

        getIssueKey: issueId => execute('Jira', () => jiraJson<unknown>(
            `/issue/${encodeURIComponent(requireText(issueId, 'Issue id'))}`,
            config,
            transport
        ).then(response => {
            if (!isRecord(response.data) || typeof response.data.key !== 'string' || !response.data.key.trim()) {
                throw new Error('Jira issue response did not contain a key.')
            }
            return response.data.key
        })),

        addWorklog: input => execute('Tempo', async () => {
            const issueId = positiveInteger(input.issueId, 'issueId')
            const timeSpentSeconds = positiveInteger(input.timeSpentSeconds, 'timeSpentSeconds')
            const body: Record<string, unknown> = {
                issueId,
                authorAccountId: config.accountId,
                timeSpentSeconds,
                startDate: requireText(input.startDate, 'startDate'),
                startTime: requireText(input.startTime, 'startTime')
            }
            if (input.description !== undefined) body.description = input.description
            if (input.remainingEstimateSeconds !== undefined) {
                body.remainingEstimateSeconds = nonNegativeInteger(input.remainingEstimateSeconds, 'remainingEstimateSeconds')
            }

            const response = await tempoJson<unknown>('/worklogs', config, transport, {
                method: 'POST',
                body
            })
            return parseWorklog(response.data)
        }),

        getWorklog: id => execute('Tempo', async () => {
            const response = await tempoJson<unknown>(`/worklogs/${encodeURIComponent(requireText(id, 'Worklog id'))}`, config, transport)
            return parseWorklog(response.data)
        }),

        deleteWorklog: id => execute('Tempo', async () => {
            await tempoJson<unknown>(`/worklogs/${encodeURIComponent(requireText(id, 'Worklog id'))}`, config, transport, {
                method: 'DELETE'
            })
        }),

        getWorklogs: (from, to) => execute('Tempo', async () => {
            const url = tempoUrl(`/worklogs/user/${encodeURIComponent(config.accountId)}`)
            url.searchParams.set('from', requireText(from, 'from date'))
            url.searchParams.set('to', requireText(to, 'to date'))
            url.searchParams.set('limit', '1000')

            const results: Worklog[] = []
            const visited = new Set<string>()
            let next: URL | undefined = url
            let pages = 0
            while (next) {
                const pageUrl = next.toString()
                if (visited.has(pageUrl)) throw new Error('Tempo pagination loop detected.')
                visited.add(pageUrl)
                if (++pages > 100) throw new Error('Tempo pagination exceeded the safety limit.')

                const response = await tempoJson<unknown>(pageUrl, config, transport)
                const page = parseWorklogPage(response.data)
                results.push(...page.results)
                next = resolveTempoNext(page.next, response.url)
            }
            return results
        }),

        getSchedule: (from, to) => execute('Tempo', async () => {
            const url = tempoUrl('/user-schedule')
            url.searchParams.set('from', requireText(from, 'from date'))
            url.searchParams.set('to', requireText(to, 'to date'))
            const response = await tempoJson<unknown>(url, config, transport)
            return parseSchedule(response.data)
        })
    }
}

type ApiCredentials = Credentials & { jiraOrigin: string }

async function tempoJson<T>(
    input: string | URL,
    credentials: ApiCredentials,
    transport: Transport,
    options: { method?: HttpMethod; body?: unknown } = {}
) {
    const url = tempoUrl(input)
    return requestJson<T>(url, {
        ...options,
        transport,
        allowedOrigin: TEMPO_ORIGIN,
        headers: { Authorization: `Bearer ${credentials.tempoToken}` }
    })
}

async function jiraJson<T>(input: string | URL, credentials: ApiCredentials, transport: Transport) {
    const url = jiraUrl(input, credentials.jiraOrigin)
    return requestJson<T>(url, {
        transport,
        allowedOrigin: credentials.jiraOrigin,
        headers: { Authorization: `Basic ${basicAuth(credentials.email, credentials.jiraToken)}` }
    })
}

function normalizeCredentials(credentials: Credentials): ApiCredentials {
    const jiraOrigin = normalizeAtlassianOrigin(credentials.hostname)
    return {
        hostname: credentials.hostname,
        email: requireText(credentials.email, 'Jira email'),
        jiraToken: requireText(credentials.jiraToken, 'Jira token'),
        tempoToken: requireText(credentials.tempoToken, 'Tempo token'),
        accountId: requireText(credentials.accountId, 'Jira accountId'),
        jiraOrigin
    }
}

function normalizeAtlassianOrigin(hostname: string): string {
    const value = requireText(hostname, 'Jira hostname')
    let url: URL
    try {
        url = new URL(value.includes('://') ? value : `https://${value}`)
    } catch {
        throw new Error('Jira hostname is invalid.')
    }

    const host = url.hostname.toLowerCase()
    if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.port ||
        url.pathname !== '/' ||
        url.search ||
        url.hash ||
        host === 'atlassian.net' ||
        !host.endsWith('.atlassian.net')
    ) {
        throw new Error('Jira hostname must be an HTTPS *.atlassian.net host.')
    }
    return url.origin
}

function tempoUrl(input: string | URL): URL {
    if (input instanceof URL) return new URL(input.toString())
    if (/^https?:\/\//i.test(input)) return new URL(input)
    return new URL(input.replace(/^\/+/, ''), `${TEMPO_API_ORIGIN}/`)
}

function jiraUrl(input: string | URL, origin: string): URL {
    if (input instanceof URL) {
        const url = new URL(input.toString())
        if (url.origin !== origin) throw new Error('Jira request origin is not allowed.')
        return url
    }
    if (/^https?:\/\//i.test(input)) {
        const url = new URL(input)
        if (url.origin !== origin) throw new Error('Jira request origin is not allowed.')
        return url
    }
    return new URL(input.replace(/^\/+/, ''), `${origin}/rest/api/3/`)
}

function resolveTempoNext(next: string | undefined, currentUrl: string): URL | undefined {
    if (!next) return undefined
    const url = new URL(next, currentUrl)
    if (url.origin !== TEMPO_ORIGIN) throw new Error('Tempo pagination origin is not allowed.')
    return url
}

function parseIdentity(value: unknown): Identity {
    if (!isRecord(value) || typeof value.accountId !== 'string' || !value.accountId.trim()) {
        throw new Error('Jira /myself did not return an accountId.')
    }
    if (value.active !== true) throw new Error('The Jira user is inactive.')
    return {
        accountId: value.accountId.trim(),
        displayName: typeof value.displayName === 'string' ? value.displayName : ''
    }
}

function parseWorklogPage(value: unknown): { results: Worklog[]; next?: string } {
    if (!isRecord(value) || !Array.isArray(value.results)) throw new Error('Tempo worklogs response is invalid.')
    const metadata = isRecord(value.metadata) ? value.metadata : undefined
    if (metadata?.next !== undefined && typeof metadata.next !== 'string') {
        throw new Error('Tempo pagination link is invalid.')
    }
    return {
        results: value.results.map(parseWorklog),
        ...(typeof metadata?.next === 'string' && metadata.next ? { next: metadata.next } : {})
    }
}

function parseWorklog(value: unknown): Worklog {
    if (!isRecord(value)) throw new Error('Tempo worklog response is invalid.')
    const issue = isRecord(value.issue) ? value.issue : undefined
    const issueId = value.issueId ?? issue?.id
    const id = value.id ?? value.tempoWorklogId
    const timeSpentSeconds = finiteNumber(value.timeSpentSeconds)
    if (timeSpentSeconds === undefined) throw new Error('Tempo worklog duration is invalid.')
    if (typeof value.startDate !== 'string' || typeof value.startTime !== 'string') {
        throw new Error('Tempo worklog date is invalid.')
    }
    return {
        id: normalizeId(id, 'Tempo worklog id'),
        issueId: normalizeId(issueId, 'Tempo issue id'),
        startDate: value.startDate,
        startTime: value.startTime,
        timeSpentSeconds,
        description: typeof value.description === 'string' ? value.description : ''
    }
}

function parseSchedule(value: unknown): DaySchedule[] {
    if (!isRecord(value) || !Array.isArray(value.results)) throw new Error('Tempo schedule response is invalid.')
    return value.results.map(item => {
        if (!isRecord(item) || typeof item.date !== 'string' || typeof item.type !== 'string') {
            throw new Error('Tempo schedule entry is invalid.')
        }
        const requiredSeconds = finiteNumber(item.requiredSeconds)
        if (requiredSeconds === undefined) throw new Error('Tempo schedule duration is invalid.')
        return { date: item.date, requiredSeconds, type: item.type }
    })
}

function normalizeId(value: unknown, label: string): string {
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
    throw new Error(`${label} is invalid.`)
}

function positiveInteger(value: unknown, label: string): number {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
        const parsed = Number(value)
        if (Number.isSafeInteger(parsed) && parsed > 0) return parsed
    }
    throw new Error(`${label} must be a positive integer.`)
}

function nonNegativeInteger(value: unknown, label: string): number {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
    throw new Error(`${label} must be a non-negative integer.`)
}

function finiteNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
    return undefined
}

function requireText(value: string, label: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`)
    return value.trim()
}

function basicAuth(email: string, token: string): string {
    const bytes = new TextEncoder().encode(`${email}:${token}`)
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary)
}

async function execute<T>(service: 'Jira' | 'Tempo', action: () => Promise<T>): Promise<T> {
    try {
        return await action()
    } catch (error) {
        throw toApiError(service, error)
    }
}

function toApiError(service: 'Jira' | 'Tempo', error: unknown): Error {
    if (!(error instanceof HttpError)) return error instanceof Error ? error : new Error(String(error))
    if (error.status === 401 || error.status === 403) {
        return new Error(`Unauthorized access to ${service}. Check the configured credentials and permissions.`)
    }

    const messages = service === 'Jira' ? jiraMessages(error.data) : tempoMessages(error.data)
    if (messages.length > 0) return new Error(`Failure (${service} API). Errors: ${messages.join(', ')}`)
    if (error.status) return new Error(`Failure (${service} API). Server status code: ${error.status}.`)
    return new Error(error.message)
}

function jiraMessages(value: unknown): string[] {
    if (!isRecord(value)) return []
    const messages: string[] = []
    if (Array.isArray(value.errorMessages)) {
        messages.push(...value.errorMessages.filter((item): item is string => typeof item === 'string'))
    }
    if (isRecord(value.errors)) {
        messages.push(...Object.values(value.errors).filter((item): item is string => typeof item === 'string'))
    }
    return messages
}

function tempoMessages(value: unknown): string[] {
    if (!isRecord(value)) return []
    const errors = value.errors
    if (Array.isArray(errors)) {
        return errors.flatMap(item => {
            if (typeof item === 'string') return [item]
            if (isRecord(item) && typeof item.message === 'string') return [item.message]
            return []
        })
    }
    if (isRecord(errors)) return Object.values(errors).filter((item): item is string => typeof item === 'string')
    if (typeof errors === 'string') return [errors]
    if (typeof value.message === 'string') return [value.message]
    return []
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}
