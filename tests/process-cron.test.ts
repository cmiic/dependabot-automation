import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'

import type { IssueComment, PullRequest, PullRequestReview } from '../src/lib/github.ts'
import { buildApprovalComment } from '../src/lib/approval-signal.ts'

function pr (number = 1, overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number,
    node_id: `PR_${number}`,
    created_at: '2020-01-01T00:00:00Z',
    user: { login: 'dependabot[bot]' },
    state: 'open',
    head: { sha: `head-${number}` },
    base: { sha: 'base' },
    mergeable_state: 'blocked',
    ...overrides
  }
}

function signal (number = 1, options: { sha?: string, status?: string, age?: number, cooldownDays?: number, login?: string } = {}): IssueComment {
  const checkedAt = new Date(Date.now() - (options.age ?? 10) * 86_400_000).toISOString()
  return {
    id: number,
    user: { login: options.login ?? 'github-actions[bot]' },
    created_at: checkedAt,
    updated_at: checkedAt,
    body: buildApprovalComment({
      status: options.status ?? 'approved',
      sha: options.sha ?? `head-${number}`,
      checkedAt,
      cooldownDays: options.cooldownDays,
      reason: 'eligible',
      packageEcosystem: 'npm_and_yarn',
      updateType: 'version-update:semver-patch'
    })
  }
}

type Fixture = {
  enabled?: string
  pulls?: PullRequest[]
  snapshots?: Record<number, PullRequest[]>
  comments?: Record<number, IssueComment[][]>
  reviews?: PullRequestReview[]
  reviewer?: string
  reviewStatus?: number
  mergeStatus?: number
}

async function runCron (t: TestContext, fixture: Fixture = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dependabot-cron-'))
  const outputPath = join(directory, 'outputs')
  const env = {
    GITHUB_OUTPUT: outputPath,
    GITHUB_TOKEN: 'test-token',
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_API_URL: 'https://api.github.test',
    GITHUB_GRAPHQL_URL: 'https://api.github.test/graphql',
    QUARANTINE_DAYS: '3',
    MERGE_METHOD: 'squash',
    APPROVE_PULL_REQUESTS: fixture.enabled
  }
  const original = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  const logs: string[] = []
  const mutations: Array<{ path: string, body: Record<string, unknown> }> = []
  const paths: string[] = []
  const reads = new Map<string, number>()
  const pulls = fixture.pulls ?? [pr()]
  t.mock.method(console, 'log', (message: string) => logs.push(message))
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname
    paths.push(path)
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
    if (init.method === 'POST' && path === '/graphql') {
      const query = String(body.query)
      if (query.includes('viewer')) return Response.json({ data: { viewer: { login: fixture.reviewer ?? 'github-actions[bot]' } } })
      mutations.push({ path, body })
      const name = query.includes('mutation Disable') ? 'disablePullRequestAutoMerge' : 'enablePullRequestAutoMerge'
      return Response.json({ data: { [name]: { pullRequest: { number: 1 } } } })
    }
    if (init.method === 'POST' || init.method === 'PUT') {
      mutations.push({ path, body })
      const status = path.endsWith('/reviews') ? fixture.reviewStatus : fixture.mergeStatus
      return Response.json(status ? { message: 'Operation refused by GitHub' } : { merged: true }, { status: status ?? 200 })
    }
    const count = reads.get(path) ?? 0
    reads.set(path, count + 1)
    if (path === '/repos/owner/repo/pulls') return Response.json(pulls)
    const number = Number(path.match(/\/(?:pulls|issues)\/(\d+)/)?.[1])
    if (path.endsWith('/comments')) {
      const history = fixture.comments?.[number] ?? [[signal(number)]]
      return Response.json(history[Math.min(count, history.length - 1)])
    }
    if (path.endsWith('/reviews')) return Response.json(fixture.reviews ?? [])
    const pull = pulls.find(item => item.number === number)
    assert.ok(pull, `Unexpected request: ${url}`)
    const history = fixture.snapshots?.[number] ?? [pull]
    return Response.json(history[Math.min(count, history.length - 1)])
  })
  try {
    await import(`../src/entrypoints/process-cron.ts?test=${randomUUID()}`)
    const output = readFileSync(outputPath, 'utf8')
    const counts = Object.fromEntries([...output.matchAll(/([\w-]+)<<[^\n]+\n(\d+)\n/g)].map(match => [match[1], Number(match[2])]))
    return { mutations, paths, logs: logs.join('\n'), counts }
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(directory, { recursive: true, force: true })
  }
}

test('approval is disabled by default and the existing auto-merge path remains available', async (t) => {
  const result = await runCron(t)
  assert.equal(result.paths.some(path => path.endsWith('/reviews')), false)
  assert.equal(result.mutations.length, 1)
  assert.equal(result.counts['automerge-enabled-count'], 1)
})

test('approval refreshes blocked state to clean and merges only the oldest candidate', async (t) => {
  const result = await runCron(t, {
    enabled: 'true',
    pulls: [pr(2), pr(1)],
    comments: { 1: [[signal(1, { age: 20 })]] },
    snapshots: { 1: [pr(), pr(), pr(), pr(1, { mergeable_state: 'clean' })] }
  })
  assert.deepEqual(result.mutations.map(item => item.path), ['/repos/owner/repo/pulls/1/reviews', '/repos/owner/repo/pulls/1/merge'])
  assert.equal(result.mutations[0].body.commit_id, 'head-1')
  assert.deepEqual(result.mutations[1].body, { merge_method: 'squash', sha: 'head-1' })
  assert.equal(result.counts['merged-count'], 1)
})

test('approval can merge a PR that already has auto-merge, without advancing another PR', async (t) => {
  const current = pr(1, { auto_merge: {} })
  const result = await runCron(t, {
    enabled: 'true',
    pulls: [current, pr(2)],
    snapshots: { 1: [current, current, current, { ...current, merged: true, state: 'closed' }] }
  })
  assert.equal(result.mutations.length, 1)
  assert.equal(result.mutations[0].path, '/repos/owner/repo/pulls/1/reviews')
  assert.equal(result.counts['merged-count'], 1)
})

test('an already-enabled PR waiting on checks still receives its missing approval', async (t) => {
  const result = await runCron(t, { enabled: 'true', pulls: [pr(1, { auto_merge: {} })] })
  assert.equal(result.mutations.length, 1)
  assert.equal(result.mutations[0].body.event, 'APPROVE')
  assert.equal(result.counts['already-enabled-count'], 1)
})

for (const [name, comment] of Object.entries({
  quarantine: signal(1, { age: 1 }),
  cooldown: signal(1, { age: 4, cooldownDays: 3 }),
  rejected: signal(1, { status: 'rejected' }),
  stale: signal(1, { sha: 'old' }),
  untrusted: signal(1, { login: 'someone' })
})) {
  test(`no approval or merge for ${name} signal`, async (t) => {
    const result = await runCron(t, { enabled: 'true', comments: { 1: [[comment]] } })
    assert.equal(result.mutations.length, 0)
  })
}

for (const state of ['behind', 'dirty', 'draft', 'unknown', null]) {
  test(`skip approval for ${state} and allow the next candidate to advance`, async (t) => {
    const result = await runCron(t, { enabled: 'true', pulls: [pr(1, { mergeable_state: state }), pr(2)] })
    assert.equal(result.mutations[0].path, '/repos/owner/repo/pulls/2/reviews')
    assert.equal(result.mutations.length, 2)
  })
}

test('draft flag prevents approval even when mergeable_state is clean', async (t) => {
  const result = await runCron(t, { enabled: 'true', pulls: [pr(1, { draft: true, mergeable_state: 'clean' })] })
  assert.equal(result.mutations.length, 0)
})

test('existing approval from the token identity avoids duplicate reviews', async (t) => {
  const result = await runCron(t, {
    enabled: 'true', reviewer: 'custom-bot[bot]',
    reviews: [{ id: 1, user: { login: 'custom-bot[bot]' }, state: 'APPROVED', commit_id: 'head-1' }]
  })
  assert.equal(result.mutations.length, 1)
  assert.equal(result.counts['automerge-enabled-count'], 1)
})

for (const review of [
  { state: 'DISMISSED', commit_id: 'head-1', login: 'github-actions[bot]' },
  { state: 'APPROVED', commit_id: 'old', login: 'github-actions[bot]' },
  { state: 'APPROVED', commit_id: 'head-1', login: 'someone' }
]) {
  test(`a ${review.state} review on ${review.commit_id} by ${review.login} does not suppress approval`, async (t) => {
    const result = await runCron(t, {
      enabled: 'true', reviews: [{ id: 1, user: { login: review.login }, state: review.state, commit_id: review.commit_id }]
    })
    assert.equal(result.mutations[0].body.event, 'APPROVE')
  })
}

test('head changes during review lookup prevent approval and disable existing auto-merge', async (t) => {
  const current = pr(1, { auto_merge: {} })
  const result = await runCron(t, {
    enabled: 'true', pulls: [current, pr(2)],
    snapshots: { 1: [current, current, { ...current, head: { sha: 'new' } }] }
  })
  assert.equal(result.mutations.length, 1)
  assert.match(String(result.mutations[0].body.query), /DisablePullRequestAutoMerge/)
})

test('signal rejected during review lookup prevents approval', async (t) => {
  const result = await runCron(t, {
    enabled: 'true', comments: { 1: [[signal()], [signal()], [signal(1, { status: 'rejected' })]] }
  })
  assert.equal(result.mutations.length, 0)
})

test('head changes after approval stop further merges and hold the queue', async (t) => {
  const result = await runCron(t, {
    enabled: 'true', pulls: [pr(), pr(2)],
    snapshots: { 1: [pr(), pr(), pr(), pr(1, { head: { sha: 'new' } })] }
  })
  assert.equal(result.mutations.length, 1)
  assert.equal(result.counts['merged-count'], 0)
})

for (const state of ['unknown', 'behind']) {
  test(`approval holds the queue when the refreshed state becomes ${state}`, async (t) => {
    const result = await runCron(t, {
      enabled: 'true', pulls: [pr(), pr(2)],
      snapshots: { 1: [pr(), pr(), pr(), pr(1, { mergeable_state: state })] }
    })
    assert.equal(result.mutations.length, 1)
  })
}

for (const status of [403, 422]) {
  test(`approval failure ${status} reports configuration guidance and prevents merge`, async (t) => {
    const result = await runCron(t, { enabled: 'true', pulls: [pr(), pr(2)], reviewStatus: status })
    assert.equal(result.mutations.length, 1)
    assert.equal(result.counts['failed-count'], 1)
    assert.match(result.logs, /Operation refused by GitHub/)
    assert.match(result.logs, /Allow GitHub Actions to create and approve pull requests/)
  })
}

test('merge refusal after approval does not advance the next candidate', async (t) => {
  const result = await runCron(t, {
    enabled: 'true', pulls: [pr(1, { mergeable_state: 'clean' }), pr(2)], mergeStatus: 409
  })
  assert.equal(result.mutations.length, 2)
  assert.equal(result.counts['merged-count'], 0)
})

test('invalid approval input fails before any API calls', async (t) => {
  await assert.rejects(runCron(t, { enabled: 'yes' }), /APPROVE_PULL_REQUESTS must be true or false/)
})
