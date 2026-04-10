import { appendFileSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

import { buildApprovalComment, isAutomationApprovalComment } from './lib/approval-signal.mjs'
import { GitHubClient, calculateAgeDays, normalizeMergeMethod, parseCsvList } from './lib/github.mjs'
import { checkChangedLockfiles } from './lib/lockfiles.mjs'

function setOutput(name, value) {
  const delimiter = `EOF_${randomUUID()}`
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${String(value ?? '')}\n${delimiter}\n`)
}

function writeOutputs(outputs) {
  for (const [name, value] of Object.entries(outputs)) {
    setOutput(name, value)
  }
}

const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
const pullRequest = event.pull_request

const outputs = {
  candidate: 'false',
  'quarantine-passed': 'false',
  'automerge-enabled': 'false',
  reason: 'not-pull-request',
  'package-ecosystem': '',
  'update-type': '',
  'age-days': '0',
  'lockfile-status': 'skipped',
}

if (!pullRequest) {
  writeOutputs(outputs)
  process.exit(0)
}

if (pullRequest.user?.login !== 'dependabot[bot]') {
  outputs.reason = 'not-dependabot'
  writeOutputs(outputs)
  process.exit(0)
}

const token = process.env.GITHUB_TOKEN
const quarantineDays = Number.parseInt(process.env.QUARANTINE_DAYS ?? '3', 10)
const allowedEcosystems = new Set(parseCsvList(process.env.ALLOWED_ECOSYSTEMS))
const packageEcosystem = process.env.METADATA_PACKAGE_ECOSYSTEM ?? ''
const updateType = process.env.METADATA_UPDATE_TYPE ?? ''
const mergeMethod = normalizeMergeMethod(process.env.MERGE_METHOD)

outputs['package-ecosystem'] = packageEcosystem
outputs['update-type'] = updateType

const ageDays = calculateAgeDays(pullRequest.created_at)
const quarantinePassed = ageDays >= quarantineDays

outputs['age-days'] = String(ageDays)
outputs['quarantine-passed'] = quarantinePassed ? 'true' : 'false'

console.log(`Evaluating PR #${pullRequest.number}`)
console.log(`  Ecosystem: ${packageEcosystem || 'unknown'}`)
console.log(`  Update type: ${updateType || 'unknown'}`)
console.log(`  Age: ${ageDays} day(s)`)

let candidate = true
let reason = 'eligible'

if (!allowedEcosystems.has(packageEcosystem)) {
  candidate = false
  reason = `unsupported-ecosystem:${packageEcosystem || 'unknown'}`
  console.log(`  Skipping: ${reason}`)
}

if (
  candidate &&
  updateType !== 'version-update:semver-patch' &&
  updateType !== 'version-update:semver-minor'
) {
  candidate = false
  reason = `unsupported-update-type:${updateType || 'unknown'}`
  console.log(`  Skipping: ${reason}`)
}

if (candidate && packageEcosystem === 'npm_and_yarn') {
  console.log('  Checking changed npm lockfiles for newly introduced dependencies...')

  const lockfileResult = checkChangedLockfiles({
    baseSha: pullRequest.base.sha,
    headSha: pullRequest.head.sha,
  })

  outputs['lockfile-status'] = lockfileResult.status

  if (lockfileResult.changedFiles.length > 0) {
    console.log(`  Changed lockfiles: ${lockfileResult.changedFiles.join(', ')}`)
  } else {
    console.log('  No changed npm lockfiles found.')
  }

  for (const skippedFile of lockfileResult.skippedFiles) {
    console.log(`  Note: ${skippedFile}`)
  }

  if (lockfileResult.errors.length > 0) {
    candidate = false
    reason = 'lockfile-check-failed'
    console.log('  Lockfile check failed:')
    for (const error of lockfileResult.errors) {
      console.log(`    - ${error}`)
    }
  } else if (lockfileResult.newDependencies.length > 0) {
    candidate = false
    reason = 'new-dependencies'
    console.log('  New dependencies detected:')
    for (const dependency of lockfileResult.newDependencies) {
      console.log(`    - ${dependency}`)
    }
  } else {
    console.log('  No newly introduced dependencies detected.')
  }
}

outputs.candidate = candidate ? 'true' : 'false'

const github = new GitHubClient({ token })
const approvalStatus = candidate ? 'approved' : 'rejected'
const approvalCommentBody = buildApprovalComment({
  status: approvalStatus,
  sha: pullRequest.head.sha,
  reason,
  packageEcosystem,
  updateType,
  lockfileStatus: outputs['lockfile-status'],
})
const existingComments = await github.listIssueComments(pullRequest.number)
const existingApprovalComment = existingComments
  .filter((comment) => comment.user?.login === 'github-actions[bot]')
  .find((comment) => isAutomationApprovalComment(comment.body))

if (existingApprovalComment) {
  await github.updateIssueComment(existingApprovalComment.id, approvalCommentBody)
} else {
  await github.createIssueComment(pullRequest.number, approvalCommentBody)
}

if (!candidate) {
  outputs.reason = reason
  writeOutputs(outputs)
  process.exit(0)
}

if (!quarantinePassed) {
  outputs.reason = 'waiting-for-quarantine'
  console.log(`  Approval signal written. Waiting for ${quarantineDays}-day quarantine.`)
  writeOutputs(outputs)
  process.exit(0)
}

if (pullRequest.auto_merge) {
  outputs['automerge-enabled'] = 'true'
  outputs.reason = 'auto-merge-already-enabled'
  console.log('  Auto-merge is already enabled.')
  writeOutputs(outputs)
  process.exit(0)
}

try {
  await github.enablePullRequestAutoMerge({
    pullRequestId: pullRequest.node_id,
    mergeMethod,
  })
  outputs['automerge-enabled'] = 'true'
  outputs.reason = 'auto-merge-enabled'
  console.log('  Auto-merge enabled.')
} catch (error) {
  outputs.reason = 'approval-signal-written'
  console.log(`  Could not enable auto-merge: ${error.message}`)
}

writeOutputs(outputs)
