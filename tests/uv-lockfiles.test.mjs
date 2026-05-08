import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { checkChangedUvLockfiles, extractDependencies } from '../scripts/lib/uv-lockfiles.mjs'

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function writeText(filePath, content) {
  writeFileSync(filePath, content)
}

function baseUvLock(extraPackages = '') {
  return [
    'version = 1',
    'revision = 3',
    'requires-python = ">=3.12"',
    '',
    '[[package]]',
    'name = "demo"',
    'version = "1.0.0"',
    'source = { editable = "." }',
    '',
    '[package.dev-dependencies]',
    'dev = [',
    '  { name = "pytest" },',
    ']',
    '',
    '[[package]]',
    'name = "requests"',
    'version = "2.31.0"',
    'source = { registry = "https://pypi.org/simple" }',
    extraPackages,
    '',
  ].join('\n')
}

test('extractDependencies supports uv lockfiles with package entries', () => {
  const dependencies = extractDependencies({
    package: [{ name: 'demo' }, { name: 'requests' }, { name: 'urllib3' }],
  })

  assert.deepEqual([...dependencies].sort(), ['demo', 'requests', 'urllib3'])
})

test('extractDependencies rejects unsupported uv lockfile formats', () => {
  assert.throws(() => extractDependencies({ packages: [] }), {
    message: 'unsupported-lockfile-format: expected lockfile.package array',
  })
})

test('checkChangedUvLockfiles reports newly introduced dependencies in uv.lock', () => {
  const repoDir = mkdtempSync(path.join(tmpdir(), 'dependabot-automation-uv-lockfiles-'))

  try {
    git(repoDir, ['init'])
    git(repoDir, ['config', 'user.name', 'Codex'])
    git(repoDir, ['config', 'user.email', 'codex@example.com'])

    const lockfilePath = path.join(repoDir, 'uv.lock')

    writeText(lockfilePath, baseUvLock())
    git(repoDir, ['add', 'uv.lock'])
    git(repoDir, ['commit', '-m', 'base'])
    const baseSha = git(repoDir, ['rev-parse', 'HEAD'])

    writeText(
      lockfilePath,
      baseUvLock([
        '[[package]]',
        'name = "urllib3"',
        'version = "2.2.1"',
        'source = { registry = "https://pypi.org/simple" }',
      ].join('\n')),
    )
    git(repoDir, ['commit', '-am', 'add urllib3'])
    const headSha = git(repoDir, ['rev-parse', 'HEAD'])

    const result = checkChangedUvLockfiles({ baseSha, headSha, cwd: repoDir })

    assert.equal(result.ok, false)
    assert.equal(result.status, 'new-dependencies')
    assert.deepEqual(result.newDependencies, ['uv.lock: urllib3'])
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
})

test('checkChangedUvLockfiles ignores version-only updates', () => {
  const repoDir = mkdtempSync(path.join(tmpdir(), 'dependabot-automation-uv-lockfiles-'))

  try {
    git(repoDir, ['init'])
    git(repoDir, ['config', 'user.name', 'Codex'])
    git(repoDir, ['config', 'user.email', 'codex@example.com'])

    const lockfilePath = path.join(repoDir, 'uv.lock')

    writeText(lockfilePath, baseUvLock())
    git(repoDir, ['add', 'uv.lock'])
    git(repoDir, ['commit', '-m', 'base'])
    const baseSha = git(repoDir, ['rev-parse', 'HEAD'])

    writeText(
      lockfilePath,
      [
        'version = 1',
        'revision = 3',
        'requires-python = ">=3.12"',
        '',
        '[[package]]',
        'name = "demo"',
        'version = "1.0.0"',
        'source = { editable = "." }',
        '',
        '[[package]]',
        'name = "requests"',
        'version = "2.32.0"',
        'source = { registry = "https://pypi.org/simple" }',
        '',
      ].join('\n'),
    )
    git(repoDir, ['commit', '-am', 'bump requests'])
    const headSha = git(repoDir, ['rev-parse', 'HEAD'])

    const result = checkChangedUvLockfiles({ baseSha, headSha, cwd: repoDir })

    assert.equal(result.ok, true)
    assert.equal(result.status, 'clear')
    assert.deepEqual(result.newDependencies, [])
    assert.deepEqual(result.errors, [])
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
})

test('checkChangedUvLockfiles treats newly added uv.lock files as manual review', () => {
  const repoDir = mkdtempSync(path.join(tmpdir(), 'dependabot-automation-uv-lockfiles-'))

  try {
    git(repoDir, ['init'])
    git(repoDir, ['config', 'user.name', 'Codex'])
    git(repoDir, ['config', 'user.email', 'codex@example.com'])

    writeText(path.join(repoDir, 'README.md'), 'demo\n')
    git(repoDir, ['add', 'README.md'])
    git(repoDir, ['commit', '-m', 'base'])
    const baseSha = git(repoDir, ['rev-parse', 'HEAD'])

    writeText(path.join(repoDir, 'uv.lock'), baseUvLock())
    git(repoDir, ['add', 'uv.lock'])
    git(repoDir, ['commit', '-m', 'add uv lock'])
    const headSha = git(repoDir, ['rev-parse', 'HEAD'])

    const result = checkChangedUvLockfiles({ baseSha, headSha, cwd: repoDir })

    assert.equal(result.ok, false)
    assert.equal(result.status, 'error')
    assert.deepEqual(result.errors, ['uv.lock:missing-in-base'])
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
})

test('checkChangedUvLockfiles treats deleted uv.lock files as manual review', () => {
  const repoDir = mkdtempSync(path.join(tmpdir(), 'dependabot-automation-uv-lockfiles-'))

  try {
    git(repoDir, ['init'])
    git(repoDir, ['config', 'user.name', 'Codex'])
    git(repoDir, ['config', 'user.email', 'codex@example.com'])

    const lockfilePath = path.join(repoDir, 'uv.lock')

    writeText(lockfilePath, baseUvLock())
    git(repoDir, ['add', 'uv.lock'])
    git(repoDir, ['commit', '-m', 'base'])
    const baseSha = git(repoDir, ['rev-parse', 'HEAD'])

    git(repoDir, ['rm', 'uv.lock'])
    git(repoDir, ['commit', '-m', 'delete uv lock'])
    const headSha = git(repoDir, ['rev-parse', 'HEAD'])

    const result = checkChangedUvLockfiles({ baseSha, headSha, cwd: repoDir })

    assert.equal(result.ok, false)
    assert.equal(result.status, 'error')
    assert.deepEqual(result.errors, ['uv.lock:missing-in-head'])
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
})

test('checkChangedUvLockfiles treats malformed uv.lock files as manual review', () => {
  const repoDir = mkdtempSync(path.join(tmpdir(), 'dependabot-automation-uv-lockfiles-'))

  try {
    git(repoDir, ['init'])
    git(repoDir, ['config', 'user.name', 'Codex'])
    git(repoDir, ['config', 'user.email', 'codex@example.com'])

    const lockfilePath = path.join(repoDir, 'uv.lock')

    writeText(lockfilePath, baseUvLock())
    git(repoDir, ['add', 'uv.lock'])
    git(repoDir, ['commit', '-m', 'base'])
    const baseSha = git(repoDir, ['rev-parse', 'HEAD'])

    writeText(lockfilePath, 'version = 1\n\n[[package]]\nname = "requests"\nsource = { registry = "https://pypi.org/simple"\n')
    git(repoDir, ['commit', '-am', 'break uv lock inline table'])
    const headSha = git(repoDir, ['rev-parse', 'HEAD'])

    const result = checkChangedUvLockfiles({ baseSha, headSha, cwd: repoDir })

    assert.equal(result.ok, false)
    assert.equal(result.status, 'error')
    assert.equal(result.errors.length, 1)
    assert.match(result.errors[0], /^uv\.lock:parse-failed:/)
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
})

test('checkChangedUvLockfiles treats malformed uv.lock table headers as manual review', () => {
  const repoDir = mkdtempSync(path.join(tmpdir(), 'dependabot-automation-uv-lockfiles-'))

  try {
    git(repoDir, ['init'])
    git(repoDir, ['config', 'user.name', 'Codex'])
    git(repoDir, ['config', 'user.email', 'codex@example.com'])

    const lockfilePath = path.join(repoDir, 'uv.lock')

    writeText(lockfilePath, baseUvLock())
    git(repoDir, ['add', 'uv.lock'])
    git(repoDir, ['commit', '-m', 'base'])
    const baseSha = git(repoDir, ['rev-parse', 'HEAD'])

    writeText(lockfilePath, '[[package]\nname = "requests"\n')
    git(repoDir, ['commit', '-am', 'break uv lock header'])
    const headSha = git(repoDir, ['rev-parse', 'HEAD'])

    const result = checkChangedUvLockfiles({ baseSha, headSha, cwd: repoDir })

    assert.equal(result.ok, false)
    assert.equal(result.status, 'error')
    assert.equal(result.errors.length, 1)
    assert.match(result.errors[0], /^uv\.lock:parse-failed:/)
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
})