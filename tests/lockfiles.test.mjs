import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { checkChangedLockfiles, extractDependencies } from '../scripts/lib/lockfiles.mjs'

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

test('extractDependencies supports lockfiles with packages entries', () => {
  const dependencies = extractDependencies({
    packages: {
      '': {},
      'node_modules/react': {},
      'node_modules/foo/node_modules/bar': {},
    },
  })

  assert.deepEqual([...dependencies].sort(), ['bar', 'react'])
})

test('extractDependencies falls back to the legacy dependencies tree', () => {
  const dependencies = extractDependencies({
    dependencies: {
      react: {
        version: '18.0.0',
        dependencies: {
          scheduler: {
            version: '0.23.0',
          },
        },
      },
    },
  })

  assert.deepEqual([...dependencies].sort(), ['react', 'scheduler'])
})

test('checkChangedLockfiles reports newly introduced dependencies in changed lockfiles', () => {
  const repoDir = mkdtempSync(path.join(tmpdir(), 'dependabot-automation-lockfiles-'))

  try {
    git(repoDir, ['init'])
    git(repoDir, ['config', 'user.name', 'Codex'])
    git(repoDir, ['config', 'user.email', 'codex@example.com'])

    const lockfilePath = path.join(repoDir, 'package-lock.json')

    writeJson(lockfilePath, {
      name: 'demo',
      lockfileVersion: 3,
      packages: {
        '': {},
        'node_modules/react': {
          version: '18.2.0',
        },
      },
    })

    git(repoDir, ['add', 'package-lock.json'])
    git(repoDir, ['commit', '-m', 'base'])
    const baseSha = git(repoDir, ['rev-parse', 'HEAD'])

    writeJson(lockfilePath, {
      name: 'demo',
      lockfileVersion: 3,
      packages: {
        '': {},
        'node_modules/react': {
          version: '18.3.0',
        },
        'node_modules/vite': {
          version: '6.0.0',
        },
      },
    })

    git(repoDir, ['commit', '-am', 'add vite'])
    const headSha = git(repoDir, ['rev-parse', 'HEAD'])

    const result = checkChangedLockfiles({ baseSha, headSha, cwd: repoDir })

    assert.equal(result.ok, false)
    assert.equal(result.status, 'new-dependencies')
    assert.deepEqual(result.newDependencies, ['package-lock.json: vite'])
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
})

test('checkChangedLockfiles ignores version-only updates', () => {
  const repoDir = mkdtempSync(path.join(tmpdir(), 'dependabot-automation-lockfiles-'))

  try {
    git(repoDir, ['init'])
    git(repoDir, ['config', 'user.name', 'Codex'])
    git(repoDir, ['config', 'user.email', 'codex@example.com'])

    const lockfilePath = path.join(repoDir, 'package-lock.json')

    writeJson(lockfilePath, {
      name: 'demo',
      lockfileVersion: 3,
      packages: {
        '': {},
        'node_modules/react': {
          version: '18.2.0',
        },
      },
    })

    git(repoDir, ['add', 'package-lock.json'])
    git(repoDir, ['commit', '-m', 'base'])
    const baseSha = git(repoDir, ['rev-parse', 'HEAD'])

    writeJson(lockfilePath, {
      name: 'demo',
      lockfileVersion: 3,
      packages: {
        '': {},
        'node_modules/react': {
          version: '18.3.0',
        },
      },
    })

    git(repoDir, ['commit', '-am', 'bump react'])
    const headSha = git(repoDir, ['rev-parse', 'HEAD'])

    const result = checkChangedLockfiles({ baseSha, headSha, cwd: repoDir })

    assert.equal(result.ok, true)
    assert.equal(result.status, 'clear')
    assert.deepEqual(result.newDependencies, [])
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
})
