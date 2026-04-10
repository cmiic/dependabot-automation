import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

import { parseApprovalComment } from './lib/approval-signal.mjs'
import { GitHubClient, calculateAgeDays, normalizeMergeMethod } from './lib/github.mjs'

function setOutput(name, value) {
  const delimiter = `EOF_${randomUUID()}`
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${String(value ?? '')}\n${delimiter}\n`)
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
let automergeEnabledCount = 0
let alreadyEnabledCount = 0
let failedCount = 0

for (const pullRequestSummary of dependabotPullRequests) {
  processedCount += 1

  const ageDays = calculateAgeDays(pullRequestSummary.created_at)

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`PR #${pullRequestSummary.number}`)
  console.log(`  Created: ${pullRequestSummary.created_at}`)
  console.log(`  Age: ${ageDays} day(s)`)

  if (ageDays < quarantineDays) {
    console.log(`  Waiting for quarantine (${ageDays} < ${quarantineDays} days)`)
    continue
  }

  quarantinePassedCount += 1
  console.log('  Quarantine passed')

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

    if (pullRequest.auto_merge) {
      alreadyEnabledCount += 1
      console.log('  Auto-merge already enabled')
      continue
    }

    await github.enablePullRequestAutoMerge({
      pullRequestId: pullRequest.node_id,
      mergeMethod,
    })

    automergeEnabledCount += 1
    console.log('  Auto-merge enabled')
  } catch (error) {
    failedCount += 1
    console.log(`  Failed to enable auto-merge: ${error.message}`)
  }
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log('Done.')

setOutput('processed-count', processedCount)
setOutput('quarantine-passed-count', quarantinePassedCount)
setOutput('automerge-enabled-count', automergeEnabledCount)
setOutput('already-enabled-count', alreadyEnabledCount)
setOutput('failed-count', failedCount)
