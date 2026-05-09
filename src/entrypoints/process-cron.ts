import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

import type { ApprovalCommentPayload } from '../lib/approval-signal.ts'
import type { IssueComment, PullRequest } from '../lib/github.ts'

import { getApprovalCheckedAt, parseApprovalComment } from '../lib/approval-signal.ts'
import { GitHubClient, GitHubRequestError, calculateAgeDays, normalizeMergeMethod } from '../lib/github.ts'

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

function setOutput (name: string, value: unknown): void {
  const delimiter = `EOF_${randomUUID()}`
  appendFileSync(githubOutputPath, `${name}<<${delimiter}\n${String(value ?? '')}\n${delimiter}\n`)
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
    const approvalComment = comments
      .filter(comment => comment.user?.login === 'github-actions[bot]')
      .map(comment => ({ comment, payload: parseApprovalComment(comment.body) }))
      .filter(hasApprovalPayload)
      .sort((left, right) => Date.parse(right.comment.updated_at) - Date.parse(left.comment.updated_at))[0]

    if (!approvalComment) {
      console.log('  Skipping: no machine-written approval signal found')
      continue
    }

    if (approvalComment.payload.status !== 'approved') {
      console.log(`  Skipping: latest approval signal status is ${approvalComment.payload.status}`)
      continue
    }

    if (approvalComment.payload.sha !== pullRequest.head.sha) {
      console.log(
        `  Skipping: approval signal is for ${approvalComment.payload.sha}, current head is ${pullRequest.head.sha}`
      )
      continue
    }

    const checkedAt = getApprovalCheckedAt(approvalComment.payload)
    if (!checkedAt) {
      console.log('  Skipping: latest approval signal has no valid checkedAt timestamp')
      continue
    }

    const ageDays = calculateAgeDays(checkedAt)
    console.log(`  Approved at: ${checkedAt}`)
    console.log(`  Approval age: ${ageDays} day(s)`)

    if (ageDays < quarantineDays) {
      console.log(`  Waiting for quarantine (${ageDays} < ${quarantineDays} days since approval)`)
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

for (const { pullRequest } of candidates) {
  const number = pullRequest.number
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`PR #${number} (acting)`)

  if (pipelineBusy) {
    console.log('  Skipping: older candidate is in flight; will revisit next run')
    continue
  }

  const state = pullRequest.mergeable_state

  try {
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
        await github.mergePullRequest(number, mergeMethod)
        mergedCount += 1
        pipelineBusy = true
        console.log('  Merged')
      } catch (mergeError) {
        if (mergeError instanceof GitHubRequestError && (mergeError.status === 405 || mergeError.status === 409)) {
          const mergeErrorMessage = isRecord(mergeError.data) && typeof mergeError.data.message === 'string'
            ? mergeError.data.message
            : getErrorMessage(mergeError)
          console.log(`  Direct merge refused (${mergeError.status}): ${mergeErrorMessage}`)
          console.log('  Not actionable from cron; waiting for Dependabot to rebase (queue continues)')
        } else {
          throw mergeError
        }
      }
    } else if (state === 'behind') {
      console.log('  Branch behind base; not actionable from cron, waiting for Dependabot to rebase (queue continues)')
    } else if (state === 'blocked' || state === 'unstable') {
      await enableAutoMerge(pullRequest, `checks pending (${state})`)
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
