import { appendFileSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

import { buildApprovalComment, buildDependencyKey, parseApprovalComment, resolveApprovalCheckedAt } from './lib/approval-signal.mjs'
import { GitHubClient, calculateAgeDays, parseCsvList } from './lib/github.mjs'
import { checkChangedLockfiles } from './lib/lockfiles.mjs'
import { findUnexpectedFiles, listChangedFiles, extractActionOwners } from './lib/pr-changes.mjs'

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
const dependencyKey = buildDependencyKey(process.env.METADATA_UPDATED_DEPENDENCIES_JSON)

outputs['package-ecosystem'] = packageEcosystem
outputs['update-type'] = updateType

console.log(`Evaluating PR #${pullRequest.number}`)
console.log(`  Ecosystem: ${packageEcosystem || 'unknown'}`)
console.log(`  Update type: ${updateType || 'unknown'}`)

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

if (candidate) {
  const changedFiles = listChangedFiles({
    baseSha: pullRequest.base.sha,
    headSha: pullRequest.head.sha,
  })
  const unexpectedFiles = findUnexpectedFiles({
    packageEcosystem,
    changedFiles,
  })

  if (unexpectedFiles.length > 0) {
    candidate = false
    reason = 'unexpected-file-modifications'
    console.log('  Unexpected files changed:')
    for (const file of unexpectedFiles) {
      console.log(`    - ${file}`)
    }
  }
}

if (candidate && packageEcosystem === 'github_actions') {
  const trustedActionOwners = new Set(parseCsvList(process.env.TRUSTED_ACTION_OWNERS))
  const dependencyNames = process.env.METADATA_DEPENDENCY_NAMES ?? ''

  if (!trustedActionOwners.has('*')) {
    const owners = extractActionOwners(dependencyNames)

    if (owners.size === 0) {
      candidate = false
      reason = 'missing-action-dependency-names'
      console.log('  Trusted action owners check failed: no dependency names available.')
    } else {
      const untrustedOwners = [...owners].filter((owner) => !trustedActionOwners.has(owner))

      if (untrustedOwners.length > 0) {
        candidate = false
        reason = 'untrusted-action-owner'
        console.log('  Untrusted action owners:')
        for (const owner of untrustedOwners) {
          console.log(`    - ${owner}`)
        }
      } else {
        console.log(`  All action owners trusted: ${[...owners].join(', ')}`)
      }
    }
  } else {
    console.log('  Trusted action owners check skipped (wildcard).')
  }
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

  for (const unsupportedFile of lockfileResult.unsupportedFiles) {
    console.log(`  Unsupported lockfile changed: ${unsupportedFile}`)
  }

  for (const skippedFile of lockfileResult.skippedFiles) {
    console.log(`  Note: ${skippedFile}`)
  }

  if (lockfileResult.status === 'unsupported-lockfile') {
    candidate = false
    reason = 'unsupported-lockfile'
    console.log('  Unsupported lockfiles require manual review.')
  } else if (lockfileResult.errors.length > 0) {
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
const existingComments = await github.listIssueComments(pullRequest.number)
const existingApprovalComment = existingComments
  .filter((comment) => comment.user?.login === 'github-actions[bot]')
  .map((comment) => ({ comment, payload: parseApprovalComment(comment.body) }))
  .filter((entry) => entry.payload)
  .sort((left, right) => Date.parse(right.comment.updated_at) - Date.parse(left.comment.updated_at))[0]

const checkedAt = resolveApprovalCheckedAt({
  existingPayload: existingApprovalComment?.payload,
  sha: pullRequest.head.sha,
  dependencyKey,
})
const ageDays = calculateAgeDays(checkedAt)
const quarantinePassed = ageDays >= quarantineDays
const approvalStatus = candidate ? 'approved' : 'rejected'

outputs['age-days'] = String(ageDays)
outputs['quarantine-passed'] = quarantinePassed ? 'true' : 'false'
outputs['automerge-enabled'] = pullRequest.auto_merge ? 'true' : 'false'

console.log(`  Approval age: ${ageDays} day(s)`)

const approvalCommentBody = buildApprovalComment({
  status: approvalStatus,
  sha: pullRequest.head.sha,
  reason,
  packageEcosystem,
  updateType,
  lockfileStatus: outputs['lockfile-status'],
  dependencyKey,
  checkedAt,
})

if (existingApprovalComment) {
  await github.updateIssueComment(existingApprovalComment.comment.id, approvalCommentBody)
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
  outputs.reason = 'auto-merge-already-enabled'
  console.log('  Auto-merge is already enabled.')
  writeOutputs(outputs)
  process.exit(0)
}

outputs.reason = 'approved-awaiting-cron'
console.log('  Approval signal written. Cron may enable auto-merge after quarantine.')
writeOutputs(outputs)
