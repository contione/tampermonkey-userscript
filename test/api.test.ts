import { expect, test } from 'vitest'
import { createApi, discoverAccount, type Credentials } from '../src/api'
import type { Transport, TransportRequest, TransportResponse } from '../src/http'

const credentials: Credentials = {
    hostname: 'example.atlassian.net',
    email: 'user@example.com',
    jiraToken: 'jira-token',
    tempoToken: 'tempo-token',
    accountId: 'account-123'
}

test('discovers the active Jira identity with Basic Auth and safe GM options', async () => {
    const mock = queue(json({ accountId: 'account-123', displayName: 'Ada', active: true }))

    await expect(discoverAccount({
        hostname: credentials.hostname,
        email: credentials.email,
        jiraToken: credentials.jiraToken
    }, mock.transport)).resolves.toEqual({ accountId: 'account-123', displayName: 'Ada' })

    const request = mock.calls[0]
    expect(request.url).toBe('https://example.atlassian.net/rest/api/3/myself')
    expect(request.method).toBe('GET')
    expect(request.headers.Authorization).toBe(`Basic ${btoa('user@example.com:jira-token')}`)
    expect(request.anonymous).toBe(true)
    expect(request.redirect).toBe('error')
    expect(request.timeoutMs).toBe(15_000)
})

test('rejects a missing or inactive Jira identity', async () => {
    const inactive = queue(json({ accountId: 'account-123', displayName: 'Ada', active: false }))
    await expect(discoverAccount({
        hostname: credentials.hostname,
        email: credentials.email,
        jiraToken: credentials.jiraToken
    }, inactive.transport)).rejects.toThrow('inactive')

    const missing = queue(json({ displayName: 'Ada', active: true }))
    await expect(discoverAccount({
        hostname: credentials.hostname,
        email: credentials.email,
        jiraToken: credentials.jiraToken
    }, missing.transport)).rejects.toThrow('accountId')
})

test('uses Jira Basic Auth and Tempo bearer auth on their own origins', async () => {
    const mock = queue(
        json({ id: '10001' }),
        json({ key: 'ABC-1' })
    )
    const api = createApi(credentials, mock.transport)

    await expect(api.getIssueId('ABC-1')).resolves.toBe('10001')
    await expect(api.getIssueKey('10001')).resolves.toBe('ABC-1')

    expect(mock.calls[0].url).toBe('https://example.atlassian.net/rest/api/3/issue/ABC-1')
    expect(mock.calls[0].headers.Authorization).toBe(`Basic ${btoa('user@example.com:jira-token')}`)
    expect(mock.calls[1].headers.Authorization).toBe(`Basic ${btoa('user@example.com:jira-token')}`)
})

test('creates a worklog with integer issueId and string authorAccountId', async () => {
    const mock = queue(json({
        tempoWorklogId: 42,
        startDate: '2026-09-20',
        startTime: '09:00:00',
        author: { accountId: 'account-123' },
        issue: { id: 10001 },
        timeSpentSeconds: 3_600,
        description: 'Build'
    }))
    const api = createApi(credentials, mock.transport)

    await expect(api.addWorklog({
        issueId: '10001',
        timeSpentSeconds: 3_600,
        startDate: '2026-09-20',
        startTime: '09:00:00',
        description: 'Build',
        remainingEstimateSeconds: 600
    })).resolves.toMatchObject({ id: '42', issueId: '10001' })

    const request = mock.calls[0]
    expect(request.method).toBe('POST')
    expect(request.url).toBe('https://api.tempo.io/4/worklogs')
    expect(request.headers.Authorization).toBe('Bearer tempo-token')
    expect(JSON.parse(request.body ?? '')).toEqual({
        issueId: 10001,
        authorAccountId: 'account-123',
        timeSpentSeconds: 3_600,
        startDate: '2026-09-20',
        startTime: '09:00:00',
        description: 'Build',
        remainingEstimateSeconds: 600
    })
})

test('does not retry a failed POST', async () => {
    const mock = queue(json({ errors: [{ message: 'Temporarily unavailable' }] }, 503))
    const api = createApi(credentials, mock.transport)

    await expect(api.addWorklog({
        issueId: '10001',
        timeSpentSeconds: 60,
        startDate: '2026-09-20',
        startTime: '09:00:00'
    })).rejects.toThrow('Temporarily unavailable')
    expect(mock.calls).toHaveLength(1)
})

test('retries a GET 429 using Retry-After and normalizes response ids', async () => {
    const mock = queue(
        json({ errors: [{ message: 'busy' }] }, 429, { 'Retry-After': '0' }),
        json({
            tempoWorklogId: 7,
            startDate: '2026-09-20',
            startTime: '09:00:00',
            author: { accountId: 'account-123' },
            issue: { id: 10007 },
            timeSpentSeconds: 60
        })
    )
    const api = createApi(credentials, mock.transport)

    await expect(api.getWorklog('7')).resolves.toEqual({
        id: '7',
        issueId: '10007',
        startDate: '2026-09-20',
        startTime: '09:00:00',
        timeSpentSeconds: 60,
        description: ''
    })
    expect(mock.calls).toHaveLength(2)
})

test('follows same-origin Tempo pagination', async () => {
    const mock = queue(
        json({
            metadata: { next: 'https://api.tempo.io/4/worklogs/user/account-123?offset=1' },
            results: [worklog(1)]
        }),
        json({ metadata: {}, results: [worklog(2)] })
    )
    const api = createApi(credentials, mock.transport)

    await expect(api.getWorklogs('2026-09-01', '2026-09-30')).resolves.toMatchObject([
        { id: '1', issueId: '10001' },
        { id: '2', issueId: '10002' }
    ])
    expect(mock.calls).toHaveLength(2)
    expect(mock.calls[1].headers.Authorization).toBe('Bearer tempo-token')
})

test('rejects a cross-origin or looping Tempo next link', async () => {
    const crossOrigin = queue(json({
        metadata: { next: 'https://attacker.example/collect' },
        results: []
    }))
    const api = createApi(credentials, crossOrigin.transport)
    await expect(api.getWorklogs('2026-09-01', '2026-09-30')).rejects.toThrow('origin')
    expect(crossOrigin.calls).toHaveLength(1)

    const loop = queue(json({
        metadata: { next: 'https://api.tempo.io/4/worklogs/user/account-123?from=2026-09-01&to=2026-09-30&limit=1000' },
        results: []
    }))
    await expect(createApi(credentials, loop.transport).getWorklogs('2026-09-01', '2026-09-30'))
        .rejects.toThrow('pagination loop')
    expect(loop.calls).toHaveLength(1)
})

test('accepts a 204 delete response without retrying', async () => {
    const mock = queue({ status: 204, responseHeaders: {} })
    const api = createApi(credentials, mock.transport)

    await expect(api.deleteWorklog('42')).resolves.toBeUndefined()
    expect(mock.calls).toHaveLength(1)
    expect(mock.calls[0].method).toBe('DELETE')
    expect(mock.calls[0].headers.Authorization).toBe('Bearer tempo-token')
})

test('maps a plain-text 401 without exposing credentials', async () => {
    const mock = queue({ status: 401, responseText: 'Unauthorized' })
    const api = createApi(credentials, mock.transport)

    await expect(api.getIssueId('ABC-1')).rejects.toThrow('Unauthorized access to Jira')
    expect(mock.calls).toHaveLength(1)
})

test('rejects arbitrary Jira hosts before invoking the transport', () => {
    const transport: Transport = async () => {
        throw new Error('transport should not be called')
    }
    expect(() => createApi({ ...credentials, hostname: 'attacker.example' }, transport)).toThrow('*.atlassian.net')
})

function worklog(id: number) {
    return {
        tempoWorklogId: id,
        startDate: '2026-09-20',
        startTime: '09:00:00',
        author: { accountId: 'account-123' },
        issue: { id: 10_000 + id },
        timeSpentSeconds: 60
    }
}

function json(value: unknown, status = 200, responseHeaders: Record<string, string> = {}): TransportResponse {
    return {
        status,
        responseText: JSON.stringify(value),
        responseHeaders
    }
}

function queue(...responses: TransportResponse[]): { transport: Transport; calls: TransportRequest[] } {
    const calls: TransportRequest[] = []
    let index = 0
    return {
        calls,
        transport: async request => {
            calls.push(request)
            const response = responses[index++]
            if (!response) throw new Error('unexpected request')
            return response
        }
    }
}
