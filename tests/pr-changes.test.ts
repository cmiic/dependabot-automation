import assert from 'node:assert/strict'
import test from 'node:test'

import { extractActionOwners, findUnexpectedFiles } from '../src/lib/pr-changes.ts'

test('findUnexpectedFiles rejects non-manifest files for npm_and_yarn PRs', () => {
  const unexpectedFiles = findUnexpectedFiles({
    packageEcosystem: 'npm_and_yarn',
    changedFiles: [
      'package.json',
      'packages/web/package-lock.json',
      'pnpm-lock.yaml',
      'src/server.js'
    ]
  })

  assert.deepEqual(unexpectedFiles, ['src/server.js'])
})

test('findUnexpectedFiles allows pyproject.toml and uv.lock for uv PRs', () => {
  const unexpectedFiles = findUnexpectedFiles({
    packageEcosystem: 'uv',
    changedFiles: ['pyproject.toml', 'uv.lock', 'services/api/pyproject.toml']
  })

  assert.deepEqual(unexpectedFiles, [])
})

test('findUnexpectedFiles rejects unrelated files for uv PRs', () => {
  const unexpectedFiles = findUnexpectedFiles({
    packageEcosystem: 'uv',
    changedFiles: ['pyproject.toml', 'uv.lock', 'requirements.txt', 'src/app.py']
  })

  assert.deepEqual(unexpectedFiles, ['requirements.txt', 'src/app.py'])
})

test('findUnexpectedFiles allows pip requirements and constraints files', () => {
  const unexpectedFiles = findUnexpectedFiles({
    packageEcosystem: 'pip',
    changedFiles: [
      'requirements.txt',
      'requirements-dev.in',
      'dev-requirements.txt',
      'constraints.txt',
      'base-constraints.in',
      'requirements/prod.txt',
      'services/api/requirements/base.in'
    ]
  })

  assert.deepEqual(unexpectedFiles, [])
})

test('findUnexpectedFiles allows text files under requirements directories for pip PRs', () => {
  const unexpectedFiles = findUnexpectedFiles({
    packageEcosystem: 'pip',
    changedFiles: ['requirements/notes.txt', 'services/api/requirements/base.in']
  })

  assert.deepEqual(unexpectedFiles, [])
})

test('findUnexpectedFiles rejects non-requirements files for pip PRs', () => {
  const unexpectedFiles = findUnexpectedFiles({
    packageEcosystem: 'pip',
    changedFiles: ['requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile', 'src/app.py']
  })

  assert.deepEqual(unexpectedFiles, ['pyproject.toml', 'setup.py', 'Pipfile', 'src/app.py'])
})

test('findUnexpectedFiles allows workflow and action metadata updates for github_actions PRs', () => {
  const unexpectedFiles = findUnexpectedFiles({
    packageEcosystem: 'github_actions',
    changedFiles: [
      '.github/workflows/ci.yml',
      'merge/action.yml',
      'cron/action.yaml'
    ]
  })

  assert.deepEqual(unexpectedFiles, [])
})

test('findUnexpectedFiles rejects unrelated files for github_actions PRs', () => {
  const unexpectedFiles = findUnexpectedFiles({
    packageEcosystem: 'github_actions',
    changedFiles: ['.github/workflows/ci.yml', 'src/index.js']
  })

  assert.deepEqual(unexpectedFiles, ['src/index.js'])
})

test('findUnexpectedFiles allows devcontainer config files and Dockerfiles', () => {
  const unexpectedFiles = findUnexpectedFiles({
    packageEcosystem: 'devcontainers',
    changedFiles: [
      '.devcontainer/devcontainer.json',
      '.devcontainer/Dockerfile',
      'services/api/.devcontainer/docker-compose.yaml'
    ]
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
      'infra/compose.yaml'
    ]
  })

  assert.deepEqual(unexpectedFiles, [])
})

test('findUnexpectedFiles returns all files for unknown ecosystems', () => {
  const changedFiles = ['README.md']
  const unexpectedFiles = findUnexpectedFiles({
    packageEcosystem: 'terraform',
    changedFiles
  })

  assert.deepEqual(unexpectedFiles, changedFiles)
})

test('extractActionOwners extracts owner from a single action', () => {
  assert.deepEqual(extractActionOwners('actions/checkout'), new Set(['actions']))
})

test('extractActionOwners extracts unique owners from multiple actions', () => {
  assert.deepEqual(
    extractActionOwners('actions/checkout, github/codeql-action, actions/setup-node'),
    new Set(['actions', 'github'])
  )
})

test('extractActionOwners returns empty set for empty input', () => {
  assert.deepEqual(extractActionOwners(''), new Set())
  assert.deepEqual(extractActionOwners(null), new Set())
  assert.deepEqual(extractActionOwners(undefined), new Set())
})
