import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

import { getApprovalCheckedAt, parseApprovalComment } from './lib/approval-signal.mjs'
import { GitHubClient, GitHubRequestError, calculateAgeDays, normalizeMergeMethod } from './lib/github.mjs'

function setOutput(name, value) {
  const delimiter = `EOF_${randomUUID()}`
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${String(value ?? '')}\n${delimiter}\n`)
}

function extractErrorMessages(error) {
  const messages = []
  if (error instanceof GitHubRequestError) {
    if (typeof error.data?.message === 'string') messages.push(error.data.message)
    if (Array.isArray(error.data?.errors)) {
      for (const item of error.data.errors) {
        if (typeof item?.message === 'string') messages.push(item.message)
      }
    }
  }
  if (typeof error?.message === 'string') messages.push(error.message)
  return messages
}

function errorMessageMatches(error, pattern) {
  return extractErrorMessages(error).some((message) => pattern.test(message))
}

function isNothingToAutoMergeError(error) {
  return errorMessageMatches(error, /clean status|pull request is in clean|nothing to merge/i)
}

function isAutoMergeAlreadyEnabledError(error) {
  return errorMessageMatches(error, /auto[- ]?merge.*already|already has auto[- ]?merge/i)
}

function isBranchAlreadyCurrentError(error) {
  return errorMessageMatches(error, /not behind|up to date/i)
}

function isMergeConflictError(error) {
  return errorMessageMatches(error, /conflict|cannot merge|cannot be automatically merged/i)
}

const token = process.env.GITHUB_TOKEN
const quarantineDays = Number.parseInt(process.env.QUARANTINE_DAYS ?? '3', 10)
const mergeMethod = normalizeMergeMethod(process.env.MERGE_METHOD)

const github = new GitHubClient({ token })
const pullRequests = await github.listOpenPullRequests()
const dependabotPullRequests = pullRequests.filter((pullRequest) => pullRequest.user?.login === 'dependabot[bot]')

console.log(`Found ${dependabotPullRequests.length} open Dependabot PR(s)`)

let processedCount = 0
let quarantinePassedCount = 0
let mergedCount = 0
let automergeEnabledCount = 0
let alreadyEnabledCount = 0
let updateBranchCount = 0
let failedCount = 0

const candidates = []

for (const pullRequestSummary of dependabotPullRequests) {
  processedCount += 1

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`PR #${pullRequestSummary.number}`)
  console.log(`  Created: ${pullRequestSummary.created_at}`)

  try {
    const pullRequest = await github.getPullRequest(pullRequestSummary.number)
    const comments = await github.listIssueComments(pullRequestSummary.number)
    const approvalComment = comments
      .filter((comment) => comment.user?.login === 'github-actions[bot]')
      .map((comment) => ({ comment, payload: parseApprovalComment(comment.body) }))
      .filter((entry) => entry.payload)
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
    console.log(`  Failed: ${error.message}`)
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
        console.log('  Auto-merge enabled but branch behind; disabling before rebase to preserve approval invariant')
        try {
          await github.disablePullRequestAutoMerge(pullRequest.node_id)
        } catch (disableError) {
          console.log(`  Could not disable existing auto-merge: ${disableError.message}`)
          throw disableError
        }
        const outcome = await requestBranchUpdate(pullRequest, 'clearing stalled auto-merge')
        if (outcome !== 'conflict') {
          pipelineBusy = true
        }
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
          console.log(`  Direct merge refused (${mergeError.status}): ${mergeError.data?.message ?? mergeError.message}`)
          const outcome = await requestBranchUpdate(pullRequest, 'branch changed under us')
          if (outcome !== 'conflict') {
            pipelineBusy = true
          }
        } else {
          throw mergeError
        }
      }
    } else if (state === 'behind') {
      const outcome = await requestBranchUpdate(pullRequest, 'branch behind base')
      if (outcome !== 'conflict') {
        pipelineBusy = true
      }
    } else if (state === 'blocked' || state === 'unstable') {
      await enableAutoMerge(pullRequest, `checks pending (${state})`)
      pipelineBusy = true
    } else if (state === 'dirty') {
      console.log('  Skipping: merge conflict, needs manual resolution')
    } else if (state === 'draft') {
      console.log('  Skipping: pull request is a draft')
    } else {
      console.log(`  Skipping: mergeable_state is ${state ?? 'null'}; holding pipeline for next run`)
      pipelineBusy = true
    }
  } catch (error) {
    failedCount += 1
    pipelineBusy = true
    console.log(`  Failed: ${error.message}`)
  }
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log('Done.')

setOutput('processed-count', processedCount)
setOutput('quarantine-passed-count', quarantinePassedCount)
setOutput('merged-count', mergedCount)
setOutput('automerge-enabled-count', automergeEnabledCount)
setOutput('already-enabled-count', alreadyEnabledCount)
setOutput('update-branch-count', updateBranchCount)
setOutput('failed-count', failedCount)

async function requestBranchUpdate(pullRequest, reason) {
  console.log(`  Updating branch (${reason})`)
  try {
    await github.updatePullRequestBranch(pullRequest.number, pullRequest.head.sha)
    updateBranchCount += 1
    console.log('  Branch update requested; next cron run will merge after re-approval')
    return 'updated'
  } catch (error) {
    if (isMergeConflictError(error)) {
      console.log(`  Branch update blocked by merge conflict; needs manual resolution`)
      return 'conflict'
    }
    if (isBranchAlreadyCurrentError(error)) {
      console.log(`  Branch already up to date: ${extractErrorMessages(error)[0] ?? error.message}`)
      return 'already-current'
    }
    throw error
  }
}

async function enableAutoMerge(pullRequest, reason) {
  console.log(`  Enabling auto-merge (${reason})`)
  try {
    await github.enablePullRequestAutoMerge({
      pullRequestId: pullRequest.node_id,
      mergeMethod,
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
