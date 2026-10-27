import assert from 'node:assert/strict'
import test from 'node:test'

import type { PullRequestReview } from '../src/lib/github.ts'
import { GitHubClient, GitHubRequestError, hasCurrentApproval } from '../src/lib/github.ts'

const login = 'github-actions[bot]'
const approval: PullRequestReview = { id: 1, user: { login }, state: 'APPROVED', commit_id: 'head' }

test('approval detection respects reviewer, commit, and subsequent review decisions', () => {
  assert.equal(hasCurrentApproval([approval], login, 'head'), true)
  assert.equal(hasCurrentApproval([approval], 'other-bot', 'head'), false)
  assert.equal(hasCurrentApproval([approval], login, 'new-head'), false)
  for (const state of ['COMMENTED', 'PENDING']) {
    assert.equal(hasCurrentApproval([approval, { ...approval, id: 2, state }], login, 'head'), true)
  }
  for (const state of ['DISMISSED', 'CHANGES_REQUESTED']) {
    assert.equal(hasCurrentApproval([approval, { ...approval, id: 2, state }], login, 'head'), false)
  }
  assert.equal(hasCurrentApproval([{ ...approval, state: 'DISMISSED' }, { ...approval, id: 2 }], login, 'head'), true)
})

test('review pagination includes decisions after the first 100 reviews', async (t) => {
  const paths: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    paths.push(url)
    return Response.json(paths.length === 1 ? Array.from({ length: 100 }, () => approval) : [{ ...approval, id: 101, state: 'DISMISSED' }])
  })
  const github = new GitHubClient({ token: 'test', repository: 'owner/repo' })
  const reviews = await github.listPullRequestReviews(42)
  assert.equal(reviews.length, 101)
  assert.equal(hasCurrentApproval(reviews, login, 'head'), false)
  assert.deepEqual(paths, [
    'https://api.github.com/repos/owner/repo/pulls/42/reviews?per_page=100&page=1',
    'https://api.github.com/repos/owner/repo/pulls/42/reviews?per_page=100&page=2'
  ])
})

test('review submission and direct merge use the validated SHA', async (t) => {
  const requests: Array<{ url: string, method: string, body: Record<string, unknown> }> = []
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    requests.push({ url, method: init.method!, body: JSON.parse(String(init.body)) })
    return Response.json(approval)
  })
  const github = new GitHubClient({ token: 'test', repository: 'owner/repo' })
  await github.approvePullRequest(42, 'head')
  await github.mergePullRequest(42, 'SQUASH', 'head')
  assert.equal(requests[0].url, 'https://api.github.com/repos/owner/repo/pulls/42/reviews')
  assert.equal(requests[0].method, 'POST')
  assert.equal(requests[0].body.event, 'APPROVE')
  assert.equal(requests[0].body.commit_id, 'head')
  assert.match(String(requests[0].body.body), /quarantine/)
  assert.deepEqual(requests[1].body, { merge_method: 'squash', sha: 'head' })
})

test('review errors preserve the GitHub response for diagnostics', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ message: 'Approval is disabled' }, { status: 403 }))
  const github = new GitHubClient({ token: 'test', repository: 'owner/repo' })
  await assert.rejects(github.approvePullRequest(42, 'head'), (error: unknown) => {
    assert.ok(error instanceof GitHubRequestError)
    assert.equal(error.status, 403)
    assert.deepEqual(error.data, { message: 'Approval is disabled' })
    return true
  })
})
