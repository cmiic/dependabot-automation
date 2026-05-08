import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  classifyChangedPipFiles,
  checkChangedPipRequirements,
  extractRequirements,
  parseRequirementLine,
} from '../scripts/lib/pip-requirements.mjs'

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function writeText(filePath, content) {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, content)
}

function initRepo() {
  const repoDir = mkdtempSync(path.join(tmpdir(), 'dependabot-automation-pip-'))
  git(repoDir, ['init'])
  git(repoDir, ['config', 'user.name', 'Codex'])
  git(repoDir, ['config', 'user.email', 'codex@example.com'])

  return repoDir
}

test('parseRequirementLine canonicalizes package names and simple specifier metadata', () => {
  assert.deepEqual(parseRequirementLine('Django_Rest.Framework[Security,Standard]==3.15.1 ; python_version >= "3.11"'), {
    type: 'requirement',
    name: 'django-rest-framework',
    operator: '==',
    version: '3.15.1',
    extras: 'security,standard',
    marker: 'python_version >= "3.11"',
    key: 'django-rest-framework|security,standard|==|python_version >= "3.11"',
    lineNumber: 1,
  })
})

test('extractRequirements ignores comments and blank lines', () => {
  const requirements = extractRequirements(`
# generated
Requests==2.31.0 # via app

`)

  assert.deepEqual([...requirements.dependencies], ['requests'])
  assert.deepEqual(requirements.complexLines, [])
})

test('classifyChangedPipFiles allows env-specific requirements directory files with requirement content', () => {
  const repoDir = initRepo()

  try {
    const prodRequirementsPath = path.join(repoDir, 'requirements/prod.txt')
    const nestedRequirementsPath = path.join(repoDir, 'services/api/requirements/base.in')

    writeText(prodRequirementsPath, 'requests==2.31.0\n')
    writeText(nestedRequirementsPath, '--index-url https://example.com/simple\n')
    git(repoDir, ['add', 'requirements/prod.txt', 'services/api/requirements/base.in'])
    git(repoDir, ['commit', '-m', 'base'])
    const baseSha = git(repoDir, ['rev-parse', 'HEAD'])

    writeText(prodRequirementsPath, 'requests==2.32.0\n')
    writeText(nestedRequirementsPath, '--index-url https://example.com/simple\nurllib3==2.2.0\n')
    git(repoDir, ['commit', '-am', 'update requirements directory files'])
    const headSha = git(repoDir, ['rev-parse', 'HEAD'])

    const result = classifyChangedPipFiles({ baseSha, headSha, cwd: repoDir })

    assert.deepEqual(result.changedFiles, ['requirements/prod.txt', 'services/api/requirements/base.in'])
    assert.deepEqual(result.unexpectedFiles, [])
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
})

test('classifyChangedPipFiles rejects non-requirement text files under requirements directories', () => {
  const repoDir = initRepo()

  try {
    const notesPath = path.join(repoDir, 'requirements/notes.txt')
    const requirementsPath = path.join(repoDir, 'requirements/prod.txt')

    writeText(notesPath, 'deployment notes\n')
    writeText(requirementsPath, 'requests==2.31.0\n')
    git(repoDir, ['add', 'requirements/notes.txt', 'requirements/prod.txt'])
    git(repoDir, ['commit', '-m', 'base'])
    const baseSha = git(repoDir, ['rev-parse', 'HEAD'])

    writeText(notesPath, 'deployment notes updated\n')
    writeText(requirementsPath, 'requests==2.32.0\n')
    git(repoDir, ['commit', '-am', 'update requirements directory files'])
    const headSha = git(repoDir, ['rev-parse', 'HEAD'])

    const result = classifyChangedPipFiles({ baseSha, headSha, cwd: repoDir })

    assert.deepEqual(result.changedFiles, ['requirements/prod.txt'])
    assert.deepEqual(result.unexpectedFiles, ['requirements/notes.txt'])
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
})

test('checkChangedPipRequirements allows version-only updates for simple requirement lines', () => {
  const repoDir = initRepo()

  try {
    const requirementsPath = path.join(repoDir, 'requirements.txt')

    writeText(
      requirementsPath,
      [
        'Requests==2.31.0',
        'Django>=4.2 ; python_version >= "3.11"',
        'uvicorn[standard]~=0.28.0',
        '',
      ].join('\n')
    )

    git(repoDir, ['add', 'requirements.txt'])
    git(repoDir, ['commit', '-m', 'base'])
    const baseSha = git(repoDir, ['rev-parse', 'HEAD'])

    writeText(
      requirementsPath,
      [
        'requests==2.32.0 # via app',
        'django>=4.3; python_version >= "3.11"',
        'uvicorn[standard]~=0.29.0',
        '',
      ].join('\n')
    )

    git(repoDir, ['commit', '-am', 'bump requirements'])
    const headSha = git(repoDir, ['rev-parse', 'HEAD'])

    const result = checkChangedPipRequirements({ baseSha, headSha, cwd: repoDir })

    assert.equal(result.ok, true)
    assert.equal(result.status, 'clear')
    assert.deepEqual(result.newDependencies, [])
    assert.deepEqual(result.errors, [])
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
})

test('checkChangedPipRequirements reports newly introduced dependencies', () => {
  const repoDir = initRepo()

  try {
    const requirementsPath = path.join(repoDir, 'requirements.txt')

    writeText(requirementsPath, 'requests==2.31.0\n')
    git(repoDir, ['add', 'requirements.txt'])
    git(repoDir, ['commit', '-m', 'base'])
    const baseSha = git(repoDir, ['rev-parse', 'HEAD'])

    writeText(requirementsPath, 'requests==2.32.0\nurllib3==2.2.0\n')
    git(repoDir, ['commit', '-am', 'add transitive dependency'])
    const headSha = git(repoDir, ['rev-parse', 'HEAD'])

    const result = checkChangedPipRequirements({ baseSha, headSha, cwd: repoDir })

    assert.equal(result.ok, false)
    assert.equal(result.status, 'new-dependencies')
    assert.deepEqual(result.newDependencies, ['requirements.txt: urllib3'])
    assert.deepEqual(result.errors, [])
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
})

test('checkChangedPipRequirements fails closed for changed operators markers extras and ranges', () => {
  const repoDir = initRepo()

  try {
    const requirementsPath = path.join(repoDir, 'requirements.txt')

    writeText(
      requirementsPath,
      [
        'requests==2.31.0',
        'django>=4.2; python_version >= "3.11"',
        'uvicorn[standard]~=0.28.0',
        'flask>=2,<3',
        '',
      ].join('\n')
    )
    git(repoDir, ['add', 'requirements.txt'])
    git(repoDir, ['commit', '-m', 'base'])
    const baseSha = git(repoDir, ['rev-parse', 'HEAD'])

    writeText(
      requirementsPath,
      [
        'requests>=2.32.0',
        'django>=4.3; python_version >= "3.12"',
        'uvicorn[watchfiles]~=0.29.0',
        'flask>=2,<4',
        '',
      ].join('\n')
    )
    git(repoDir, ['commit', '-am', 'change unsupported requirement metadata'])
    const headSha = git(repoDir, ['rev-parse', 'HEAD'])

    const result = checkChangedPipRequirements({ baseSha, headSha, cwd: repoDir })

    assert.equal(result.ok, false)
    assert.equal(result.status, 'error')
    assert.deepEqual(result.newDependencies, [])
    assert.deepEqual(result.errors, [
      'requirements.txt:unsupported-requirement:4:range',
      'requirements.txt:unsupported-requirement-removed:4:range',
      'requirements.txt:unsupported-requirement-change:django',
      'requirements.txt:unsupported-requirement-change:requests',
      'requirements.txt:unsupported-requirement-change:uvicorn',
    ])
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
})

test('checkChangedPipRequirements fails closed when one of multiple requirement variants is removed', () => {
  const repoDir = initRepo()

  try {
    const requirementsPath = path.join(repoDir, 'requirements.txt')

    writeText(
      requirementsPath,
      [
        'requests==2.31.0',
        'requests==2.31.0; python_version < "3.12"',
        '',
      ].join('\n')
    )
    git(repoDir, ['add', 'requirements.txt'])
    git(repoDir, ['commit', '-m', 'base'])
    const baseSha = git(repoDir, ['rev-parse', 'HEAD'])

    writeText(
      requirementsPath,
      [
        'requests==2.32.0',
        '',
      ].join('\n')
    )
    git(repoDir, ['commit', '-am', 'remove variant'])
    const headSha = git(repoDir, ['rev-parse', 'HEAD'])

    const result = checkChangedPipRequirements({ baseSha, headSha, cwd: repoDir })

    assert.equal(result.ok, false)
    assert.equal(result.status, 'error')
    assert.deepEqual(result.newDependencies, [])
    assert.deepEqual(result.errors, ['requirements.txt:unsupported-requirement-change:requests'])
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
})

test('checkChangedPipRequirements fails closed for newly added complex requirement lines', () => {
  const repoDir = initRepo()

  try {
    const requirementsPath = path.join(repoDir, 'requirements.txt')

    writeText(requirementsPath, 'requests==2.31.0\n')
    git(repoDir, ['add', 'requirements.txt'])
    git(repoDir, ['commit', '-m', 'base'])
    const baseSha = git(repoDir, ['rev-parse', 'HEAD'])

    writeText(
      requirementsPath,
      [
        'requests==2.32.0',
        '-e git+https://example.com/editable.git#egg=editable',
        'git+https://example.com/vcs.git#egg=vcs',
        './localpkg',
        'directpkg @ https://example.com/directpkg.whl',
        '-r other-requirements.txt',
        '--index-url https://example.com/simple',
        'barepkg',
        '',
      ].join('\n')
    )
    git(repoDir, ['commit', '-am', 'add complex requirement lines'])
    const headSha = git(repoDir, ['rev-parse', 'HEAD'])

    const result = checkChangedPipRequirements({ baseSha, headSha, cwd: repoDir })

    assert.equal(result.ok, false)
    assert.equal(result.status, 'error')
    assert.deepEqual(result.newDependencies, [])
    assert.deepEqual(result.errors, [
      'requirements.txt:unsupported-requirement:2:editable',
      'requirements.txt:unsupported-requirement:3:url',
      'requirements.txt:unsupported-requirement:4:path',
      'requirements.txt:unsupported-requirement:5:direct-reference',
      'requirements.txt:unsupported-requirement:6:include',
      'requirements.txt:unsupported-requirement:7:option',
      'requirements.txt:unsupported-requirement:8:unparseable',
    ])
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
})

test('checkChangedPipRequirements allows unchanged complex lines next to simple version bumps', () => {
  const repoDir = initRepo()

  try {
    const requirementsPath = path.join(repoDir, 'requirements.txt')

    writeText(requirementsPath, '--index-url https://example.com/simple\nflask>=2,<3\nrequests==2.31.0\n')
    git(repoDir, ['add', 'requirements.txt'])
    git(repoDir, ['commit', '-m', 'base'])
    const baseSha = git(repoDir, ['rev-parse', 'HEAD'])

    writeText(requirementsPath, '--index-url https://example.com/simple\nflask>=2,<3\nrequests==2.32.0\n')
    git(repoDir, ['commit', '-am', 'bump requests'])
    const headSha = git(repoDir, ['rev-parse', 'HEAD'])

    const result = checkChangedPipRequirements({ baseSha, headSha, cwd: repoDir })

    assert.equal(result.ok, true)
    assert.equal(result.status, 'clear')
    assert.deepEqual(result.newDependencies, [])
    assert.deepEqual(result.errors, [])
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
})

test('checkChangedPipRequirements fails closed when complex requirement lines are removed', () => {
  const repoDir = initRepo()

  try {
    const requirementsPath = path.join(repoDir, 'requirements.txt')

    writeText(requirementsPath, '--index-url https://example.com/simple\nrequests==2.31.0\n')
    git(repoDir, ['add', 'requirements.txt'])
    git(repoDir, ['commit', '-m', 'base'])
    const baseSha = git(repoDir, ['rev-parse', 'HEAD'])

    writeText(requirementsPath, 'requests==2.32.0\n')
    git(repoDir, ['commit', '-am', 'remove index option'])
    const headSha = git(repoDir, ['rev-parse', 'HEAD'])

    const result = checkChangedPipRequirements({ baseSha, headSha, cwd: repoDir })

    assert.equal(result.ok, false)
    assert.equal(result.status, 'error')
    assert.deepEqual(result.newDependencies, [])
    assert.deepEqual(result.errors, ['requirements.txt:unsupported-requirement-removed:1:option'])
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
})

test('checkChangedPipRequirements treats newly added requirements files as manual review', () => {
  const repoDir = initRepo()

  try {
    writeText(path.join(repoDir, 'README.md'), 'demo\n')
    git(repoDir, ['add', 'README.md'])
    git(repoDir, ['commit', '-m', 'base'])
    const baseSha = git(repoDir, ['rev-parse', 'HEAD'])

    writeText(path.join(repoDir, 'requirements.txt'), 'requests==2.31.0\n')
    git(repoDir, ['add', 'requirements.txt'])
    git(repoDir, ['commit', '-m', 'add requirements'])
    const headSha = git(repoDir, ['rev-parse', 'HEAD'])

    const result = checkChangedPipRequirements({ baseSha, headSha, cwd: repoDir })

    assert.equal(result.ok, false)
    assert.equal(result.status, 'error')
    assert.deepEqual(result.errors, ['requirements.txt:missing-in-base'])
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
})

test('checkChangedPipRequirements treats deleted requirements files as manual review', () => {
  const repoDir = initRepo()

  try {
    const requirementsPath = path.join(repoDir, 'requirements.txt')

    writeText(requirementsPath, 'requests==2.31.0\n')
    git(repoDir, ['add', 'requirements.txt'])
    git(repoDir, ['commit', '-m', 'base'])
    const baseSha = git(repoDir, ['rev-parse', 'HEAD'])

    git(repoDir, ['rm', 'requirements.txt'])
    git(repoDir, ['commit', '-m', 'delete requirements'])
    const headSha = git(repoDir, ['rev-parse', 'HEAD'])

    const result = checkChangedPipRequirements({ baseSha, headSha, cwd: repoDir })

    assert.equal(result.ok, false)
    assert.equal(result.status, 'error')
    assert.deepEqual(result.skippedFiles, [])
    assert.deepEqual(result.errors, ['requirements.txt:missing-in-head'])
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
})
