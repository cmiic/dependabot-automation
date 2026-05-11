import { appendFileSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

import type { ApprovalCommentPayload } from '../lib/approval-signal.ts'
import type { IssueComment, PullRequest } from '../lib/github.ts'

import { buildApprovalComment, buildDependencyKey, parseApprovalComment, resolveApprovalCheckedAt } from '../lib/approval-signal.ts'
import { GitHubClient, calculateAgeDays, parseCsvList } from '../lib/github.ts'
import { checkChangedLockfiles } from '../lib/lockfiles.ts'
import { checkChangedPipRequirements, classifyChangedPipFiles } from '../lib/pip-requirements.ts'
import { extractActionOwners, findUnexpectedFiles, listChangedFiles } from '../lib/pr-changes.ts'
import { checkChangedUvLockfiles } from '../lib/uv-lockfiles.ts'

type ApprovalCommentEntry = {
  comment: IssueComment
  payload: ApprovalCommentPayload | null
}

type PullRequestEvent = {
  pull_request?: PullRequest | null
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

function writeOutputs (outputs: Record<string, string>): void {
  for (const [name, value] of Object.entries(outputs)) {
    setOutput(name, value)
  }
}

function hasApprovalPayload (entry: ApprovalCommentEntry): entry is { comment: IssueComment, payload: ApprovalCommentPayload } {
  return entry.payload !== null
}

const event = JSON.parse(readFileSync(requiredEnv('GITHUB_EVENT_PATH'), 'utf8')) as PullRequestEvent
const pullRequest = event.pull_request

const outputs: Record<string, string> = {
  'candidate': 'false',
  'quarantine-passed': 'false',
  'automerge-enabled': 'false',
  'reason': 'not-pull-request',
  'package-ecosystem': '',
  'update-type': '',
  'age-days': '0',
  'dependency-file-status': 'skipped',
  'lockfile-status': 'skipped'
}

function setDependencyFileStatus (status: string): void {
  outputs['dependency-file-status'] = status
  outputs['lockfile-status'] = status
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
let pipFileClassification: ReturnType<typeof classifyChangedPipFiles> | null = null

if (!allowedEcosystems.has(packageEcosystem)) {
  candidate = false
  reason = `unsupported-ecosystem:${packageEcosystem || 'unknown'}`
  console.log(`  Skipping: ${reason}`)
}

if (
  candidate
  && updateType !== 'version-update:semver-patch'
  && updateType !== 'version-update:semver-minor'
) {
  candidate = false
  reason = `unsupported-update-type:${updateType || 'unknown'}`
  console.log(`  Skipping: ${reason}`)
}

if (candidate) {
  const changedFiles = listChangedFiles({
    baseSha: pullRequest.base.sha,
    headSha: pullRequest.head.sha
  })
  pipFileClassification = packageEcosystem === 'pip'
    ? classifyChangedPipFiles({
        baseSha: pullRequest.base.sha,
        headSha: pullRequest.head.sha,
        changedFiles
      })
    : null
  const unexpectedFiles = pipFileClassification
    ? pipFileClassification.unexpectedFiles
    : findUnexpectedFiles({
        packageEcosystem,
        changedFiles
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
      const untrustedOwners = [...owners].filter(owner => !trustedActionOwners.has(owner))

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
    headSha: pullRequest.head.sha
  })

  setDependencyFileStatus(lockfileResult.status)

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
  } else if (lockfileResult.status === 'no-lockfiles') {
    candidate = false
    reason = 'no-lockfiles'
    console.log('  No supported npm lockfiles changed; manual review required.')
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

if (candidate && packageEcosystem === 'uv') {
  console.log('  Checking changed uv lockfiles for newly introduced dependencies...')

  const lockfileResult = checkChangedUvLockfiles({
    baseSha: pullRequest.base.sha,
    headSha: pullRequest.head.sha
  })

  setDependencyFileStatus(lockfileResult.status)

  if (lockfileResult.changedFiles.length > 0) {
    console.log(`  Changed uv lockfiles: ${lockfileResult.changedFiles.join(', ')}`)
  } else {
    console.log('  No changed uv lockfiles found.')
  }

  for (const skippedFile of lockfileResult.skippedFiles) {
    console.log(`  Note: ${skippedFile}`)
  }

  if (lockfileResult.status === 'no-lockfiles') {
    candidate = false
    reason = 'no-lockfiles'
    console.log('  No changed uv lockfiles found; manual review required.')
  } else if (lockfileResult.errors.length > 0) {
    candidate = false
    reason = 'dependency-file-check-failed'
    console.log('  uv lockfile check failed:')
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

if (candidate && packageEcosystem === 'pip') {
  console.log('  Checking changed pip requirements files for newly introduced dependencies...')

  const requirementsResult = checkChangedPipRequirements({
    baseSha: pullRequest.base.sha,
    headSha: pullRequest.head.sha,
    changedFiles: pipFileClassification?.requirementFiles
  })

  setDependencyFileStatus(requirementsResult.status)

  if (requirementsResult.changedFiles.length > 0) {
    console.log(`  Changed pip requirements files: ${requirementsResult.changedFiles.join(', ')}`)
  } else {
    console.log('  No changed pip requirements files found.')
  }

  for (const skippedFile of requirementsResult.skippedFiles) {
    console.log(`  Note: ${skippedFile}`)
  }

  if (requirementsResult.errors.length > 0) {
    candidate = false
    reason = 'dependency-file-check-failed'
    console.log('  Pip requirements check failed:')
    for (const error of requirementsResult.errors) {
      console.log(`    - ${error}`)
    }
  } else if (requirementsResult.newDependencies.length > 0) {
    candidate = false
    reason = 'new-dependencies'
    console.log('  New dependencies detected:')
    for (const dependency of requirementsResult.newDependencies) {
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
  .filter(comment => comment.user?.login === 'github-actions[bot]')
  .map(comment => ({ comment, payload: parseApprovalComment(comment.body) }))
  .filter(hasApprovalPayload)
  .sort((left, right) => Date.parse(right.comment.updated_at) - Date.parse(left.comment.updated_at))[0]

const checkedAt = resolveApprovalCheckedAt({
  existingPayload: existingApprovalComment?.payload,
  existingComment: existingApprovalComment?.comment,
  sha: pullRequest.head.sha,
  dependencyKey
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
  dependencyFileStatus: outputs['dependency-file-status'],
  lockfileStatus: outputs['lockfile-status'],
  dependencyKey,
  checkedAt
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
