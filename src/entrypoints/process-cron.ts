import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

import type { ApprovalCommentPayload } from '../lib/approval-signal.ts'
import type { IssueComment, PullRequest } from '../lib/github.ts'

import { getApprovalCheckedAt, getApprovalCooldownDays, parseApprovalComment, requiredApprovalAgeDays } from '../lib/approval-signal.ts'
import { GitHubClient, GitHubRequestError, calculateAgeDays, hasCurrentApproval, normalizeMergeMethod } from '../lib/github.ts'

type ApprovalCommentEntry = {
  comment: IssueComment
  payload: ApprovalCommentPayload | null
}

function requiredEnv (name: string): string {
  const value = process.env[name]

  if (!value) {
    throw new Error(`Missing ${name}`)
  }

  return value
}

const githubOutputPath = requiredEnv('GITHUB_OUTPUT')

function setOutput (name: string, value: string | number): void {
  const delimiter = `EOF_${randomUUID()}`
  appendFileSync(githubOutputPath, `${name}<<${delimiter}\n${String(value)}\n${delimiter}\n`)
}

function hasApprovalPayload (entry: ApprovalCommentEntry): entry is { comment: IssueComment, payload: ApprovalCommentPayload } {
  return entry.payload !== null
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getErrorMessage (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function extractErrorMessages (error: unknown): string[] {
  const messages: string[] = []

  if (error instanceof GitHubRequestError && isRecord(error.data)) {
    if (typeof error.data.message === 'string') {
      messages.push(error.data.message)
    }

    if (Array.isArray(error.data.errors)) {
      for (const item of error.data.errors) {
        if (isRecord(item) && typeof item.message === 'string') {
          messages.push(item.message)
        }
      }
    }
  }

  if (error instanceof Error) {
    messages.push(error.message)
  }

  return messages
}

function errorMessageMatches (error: unknown, pattern: RegExp): boolean {
  return extractErrorMessages(error).some(message => pattern.test(message))
}

function isNothingToAutoMergeError (error: unknown): boolean {
  return errorMessageMatches(error, /clean status|pull request is in clean|nothing to merge/i)
}

function isAutoMergeAlreadyEnabledError (error: unknown): boolean {
  return errorMessageMatches(error, /auto[- ]?merge.*already|already has auto[- ]?merge/i)
}

const token = process.env.GITHUB_TOKEN
const quarantineDays = Number.parseInt(process.env.QUARANTINE_DAYS ?? '3', 10)
const mergeMethod = normalizeMergeMethod(process.env.MERGE_METHOD)
const approvalInput = process.env.APPROVE_PULL_REQUESTS ?? 'false'
if (approvalInput !== 'true' && approvalInput !== 'false') {
  throw new Error('APPROVE_PULL_REQUESTS must be true or false')
}
const approvePullRequests = approvalInput === 'true'
let reviewerLogin: string | undefined

const github = new GitHubClient({ token })
const pullRequests = await github.listOpenPullRequests()
const dependabotPullRequests = pullRequests.filter(pullRequest => pullRequest.user?.login === 'dependabot[bot]')

console.log(`Found ${dependabotPullRequests.length} open Dependabot PR(s)`)

let processedCount = 0
let quarantinePassedCount = 0
let mergedCount = 0
let automergeEnabledCount = 0
let alreadyEnabledCount = 0
let failedCount = 0

const candidates: Array<{ pullRequest: PullRequest, checkedAt: string }> = []

for (const pullRequestSummary of dependabotPullRequests) {
  processedCount += 1

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`PR #${pullRequestSummary.number}`)
  console.log(`  Created: ${pullRequestSummary.created_at}`)

  try {
    const pullRequest = await github.getPullRequest(pullRequestSummary.number)
    const comments = await github.listIssueComments(pullRequestSummary.number)
    const checkedAt = getEligibleCheckedAt(pullRequest, comments)
    if (!checkedAt) {
      continue
    }

    quarantinePassedCount += 1
    console.log(`  Quarantine passed (mergeable_state: ${pullRequest.mergeable_state ?? 'unknown'})`)

    candidates.push({ pullRequest, checkedAt })
  } catch (error) {
    failedCount += 1
    console.log(`  Failed: ${getErrorMessage(error)}`)
  }
}

candidates.sort((left, right) => Date.parse(left.checkedAt) - Date.parse(right.checkedAt))

let pipelineBusy = false

for (const candidate of candidates) {
  let pullRequest = candidate.pullRequest
  const number = pullRequest.number
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`PR #${number} (acting)`)

  if (pipelineBusy) {
    console.log('  Skipping: older candidate is in flight; will revisit next run')
    continue
  }

  try {
    const refreshed = await refreshCandidate(pullRequest)
    if (!refreshed) {
      continue
    }
    pullRequest = refreshed

    if (approvePullRequests && canApprove(pullRequest)) {
      reviewerLogin ??= await github.getViewerLogin()
      const reviews = await github.listPullRequestReviews(number)
      if (!hasCurrentApproval(reviews, reviewerLogin, pullRequest.head.sha)) {
        // Review listing may take time. Re-check the signal and head immediately
        // before submission; commit_id is not a compare-and-swap guard.
        const beforeReview = await refreshCandidate(pullRequest)
        if (!beforeReview) {
          continue
        }
        pullRequest = beforeReview
        if (canApprove(pullRequest)) {
          // Approval can immediately merge a PR whose auto-merge is enabled.
          // Hold the queue even if a later read or merge attempt is inconclusive.
          pipelineBusy = true
          try {
            await github.approvePullRequest(number, pullRequest.head.sha)
          } catch (error) {
            console.log(`  Approval failed: ${extractErrorMessages(error).join('; ')}`)
            console.log('  Check pull-requests: write and Settings > Actions > General > Allow GitHub Actions to create and approve pull requests (including organization/enterprise policy). The token identity must differ from the PR author.')
            throw error
          }
          console.log(`  Submitted approval for ${pullRequest.head.sha}`)
          const afterReview = await github.getPullRequest(number)
          if (afterReview.merged) {
            mergedCount += 1
            console.log('  Merged after approval')
            continue
          }
          const validated = await validateCandidate(pullRequest, afterReview)
          if (!validated) {
            continue
          }
          pullRequest = validated
        }
      } else {
        console.log(`  Reviewer ${reviewerLogin} already approved ${pullRequest.head.sha}`)
        // Refresh even when no review is needed: listing reviews is not atomic
        // with the subsequent merge or auto-merge operation.
        const validated = await refreshCandidate(pullRequest)
        if (!validated) {
          continue
        }
        pullRequest = validated
      }
    }

    const state = pullRequest.mergeable_state
    if (pullRequest.draft) {
      console.log('  Skipping: pull request is a draft')
      continue
    }
    if (pullRequest.auto_merge) {
      if (state === 'behind') {
        console.log('  Auto-merge enabled but branch behind; disabling so the rebased SHA cannot merge before cron re-validates approval')
        try {
          await github.disablePullRequestAutoMerge(pullRequest.node_id)
        } catch (disableError) {
          console.log(`  Could not disable existing auto-merge: ${getErrorMessage(disableError)}`)
          throw disableError
        }
        console.log('  Waiting for Dependabot to rebase')
        pipelineBusy = true
      } else if (state === 'dirty') {
        console.log('  Auto-merge enabled but branch has conflicts; needs manual resolution')
      } else {
        alreadyEnabledCount += 1
        pipelineBusy = true
        console.log(`  Auto-merge already enabled (state: ${state ?? 'null'}); holding pipeline`)
      }
    } else if (state === 'clean') {
      try {
        await github.mergePullRequest(number, mergeMethod, pullRequest.head.sha)
        mergedCount += 1
        pipelineBusy = true
        console.log('  Merged')
      } catch (mergeError) {
        if (mergeError instanceof GitHubRequestError && (mergeError.status === 405 || mergeError.status === 409)) {
          const mergeErrorMessage = isRecord(mergeError.data) && typeof mergeError.data.message === 'string'
            ? mergeError.data.message
            : getErrorMessage(mergeError)
          console.log(`  Direct merge refused (${mergeError.status}): ${mergeErrorMessage}`)
          console.log(`  Merge requirements or head changed; will retry next run (${pipelineBusy ? 'queue held after approval' : 'queue continues'})`)
        } else {
          throw mergeError
        }
      }
    } else if (state === 'behind') {
      console.log('  Branch behind base; not actionable from cron, waiting for Dependabot to rebase (queue continues)')
    } else if (state === 'blocked' || state === 'unstable') {
      await enableAutoMerge(pullRequest, `merge requirements pending (${state})`)
      pipelineBusy = true
    } else if (state === 'dirty') {
      console.log('  Skipping: merge conflict, needs manual resolution')
    } else if (state === 'draft') {
      console.log('  Skipping: pull request is a draft')
    } else {
      console.log(`  Skipping: mergeable_state is ${state ?? 'null'}; will be retried next run`)
    }
  } catch (error) {
    failedCount += 1
    pipelineBusy = true
    console.log(`  Failed: ${getErrorMessage(error)}`)
  }
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log('Done.')

setOutput('processed-count', processedCount)
setOutput('quarantine-passed-count', quarantinePassedCount)
setOutput('merged-count', mergedCount)
setOutput('automerge-enabled-count', automergeEnabledCount)
setOutput('already-enabled-count', alreadyEnabledCount)
setOutput('failed-count', failedCount)

async function enableAutoMerge (pullRequest: PullRequest, reason: string): Promise<void> {
  console.log(`  Enabling auto-merge (${reason})`)
  try {
    await github.enablePullRequestAutoMerge({
      pullRequestId: pullRequest.node_id,
      mergeMethod
    })
    automergeEnabledCount += 1
    console.log('  Auto-merge enabled')
  } catch (error) {
    if (isAutoMergeAlreadyEnabledError(error)) {
      alreadyEnabledCount += 1
      console.log('  Auto-merge already enabled')
      return
    }
    if (isNothingToAutoMergeError(error)) {
      console.log('  PR is already mergeable; next cron run will merge directly')
      return
    }
    throw error
  }
}

function getEligibleCheckedAt (pullRequest: PullRequest, comments: IssueComment[]): string | null {
  const approvalComment = comments
    .filter(comment => comment.user?.login === 'github-actions[bot]')
    .map(comment => ({ comment, payload: parseApprovalComment(comment.body) }))
    .filter(hasApprovalPayload)
    .sort((left, right) => Date.parse(right.comment.updated_at) - Date.parse(left.comment.updated_at))[0]

  if (!approvalComment) {
    console.log('  Skipping: no machine-written approval signal found')
    return null
  }

  if (approvalComment.payload.status !== 'approved') {
    console.log(`  Skipping: latest approval signal status is ${approvalComment.payload.status}`)
    return null
  }

  if (approvalComment.payload.sha !== pullRequest.head.sha) {
    console.log(
      `  Skipping: approval signal is for ${approvalComment.payload.sha}, current head is ${pullRequest.head.sha}`
    )
    return null
  }

  const checkedAt = getApprovalCheckedAt(approvalComment.payload, approvalComment.comment)
  if (!checkedAt) {
    console.log('  Skipping: latest approval signal has no valid checkedAt timestamp')
    return null
  }

  const cooldownDays = getApprovalCooldownDays(approvalComment.payload)
  if (cooldownDays === null) {
    console.log('  Skipping: latest approval signal has an invalid cooldownDays value')
    return null
  }

  const requiredAgeDays = requiredApprovalAgeDays({ quarantineDays, cooldownDays })
  const ageDays = calculateAgeDays(checkedAt)
  console.log(`  Approved at: ${checkedAt}`)
  console.log(`  Approval age: ${ageDays} day(s)`)

  if (ageDays < requiredAgeDays) {
    const cooldownNote = cooldownDays > 0 ? `, including ${cooldownDays} for the cooldown Dependabot could not apply` : ''
    console.log(`  Waiting for quarantine (${ageDays} < ${requiredAgeDays} days since approval${cooldownNote})`)
    return null
  }

  return checkedAt
}

function canApprove (pullRequest: PullRequest): boolean {
  return !pullRequest.draft && ['clean', 'blocked', 'unstable'].includes(pullRequest.mergeable_state ?? '')
}

async function refreshCandidate (expected: PullRequest): Promise<PullRequest | null> {
  return validateCandidate(expected, await github.getPullRequest(expected.number))
}

async function validateCandidate (expected: PullRequest, current: PullRequest): Promise<PullRequest | null> {
  if (current.state !== 'open' || current.user?.login !== 'dependabot[bot]') {
    console.log('  Skipping: PR is no longer an open Dependabot PR')
    return null
  }
  const comments = await github.listIssueComments(current.number)
  if (current.head.sha !== expected.head.sha || !getEligibleCheckedAt(current, comments)) {
    console.log('  Skipping: head or approval eligibility changed; will revisit next run')
    if (current.auto_merge) {
      await github.disablePullRequestAutoMerge(current.node_id)
      pipelineBusy = true
      console.log('  Disabled auto-merge until approval can be re-validated')
    }
    return null
  }
  return current
}
