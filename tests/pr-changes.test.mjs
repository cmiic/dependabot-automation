import assert from 'node:assert/strict'
import test from 'node:test'

import { findUnexpectedFiles } from '../scripts/lib/pr-changes.mjs'

test('findUnexpectedFiles rejects non-manifest files for npm_and_yarn PRs', () => {
  const unexpectedFiles = findUnexpectedFiles({
    packageEcosystem: 'npm_and_yarn',
    changedFiles: [
      'package.json',
      'packages/web/package-lock.json',
      'pnpm-lock.yaml',
      'src/server.js',
    ],
  })

  assert.deepEqual(unexpectedFiles, ['src/server.js'])
})

test('findUnexpectedFiles allows workflow and action metadata updates for github-actions PRs', () => {
  const unexpectedFiles = findUnexpectedFiles({
    packageEcosystem: 'github-actions',
    changedFiles: [
      '.github/workflows/ci.yml',
      'merge/action.yml',
      'cron/action.yaml',
    ],
  })

  assert.deepEqual(unexpectedFiles, [])
})

test('findUnexpectedFiles rejects unrelated files for github-actions PRs', () => {
  const unexpectedFiles = findUnexpectedFiles({
    packageEcosystem: 'github-actions',
    changedFiles: ['.github/workflows/ci.yml', 'src/index.js'],
  })

  assert.deepEqual(unexpectedFiles, ['src/index.js'])
})

test('findUnexpectedFiles allows devcontainer config files and Dockerfiles', () => {
  const unexpectedFiles = findUnexpectedFiles({
    packageEcosystem: 'devcontainers',
    changedFiles: [
      '.devcontainer/devcontainer.json',
      '.devcontainer/Dockerfile',
      'services/api/.devcontainer/docker-compose.yaml',
    ],
  })

  assert.deepEqual(unexpectedFiles, [])
})

test('findUnexpectedFiles allows Dockerfiles and compose files for docker PRs', () => {
  const unexpectedFiles = findUnexpectedFiles({
    packageEcosystem: 'docker',
    changedFiles: [
      'Dockerfile',
      'deploy/api.Dockerfile',
      'docker-compose.yml',
      'infra/compose.yaml',
    ],
  })

  assert.deepEqual(unexpectedFiles, [])
})

test('findUnexpectedFiles returns all files for unknown ecosystems', () => {
  const changedFiles = ['README.md']
  const unexpectedFiles = findUnexpectedFiles({
    packageEcosystem: 'terraform',
    changedFiles,
  })

  assert.deepEqual(unexpectedFiles, changedFiles)
})
