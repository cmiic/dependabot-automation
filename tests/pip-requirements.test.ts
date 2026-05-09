import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  checkChangedPipRequirements,
  classifyChangedPipFiles,
  extractRequirements,
  parseRequirementLine
} from '../src/lib/pip-requirements.ts'

function git (cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function writeText (filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, content)
}

function initRepo (): string {
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
    lineNumber: 1
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
        ''
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
        ''
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

test('checkChangedPipRequirements treats dependency removals as manual review', () => {
  const repoDir = initRepo()

  try {
    const requirementsPath = path.join(repoDir, 'requirements.txt')

    writeText(
      requirementsPath,
      [
        'requests==2.31.0',
        'django==4.2.0',
        ''
      ].join('\n')
    )
    git(repoDir, ['add', 'requirements.txt'])
    git(repoDir, ['commit', '-m', 'base'])
    const baseSha = git(repoDir, ['rev-parse', 'HEAD'])

    writeText(
      requirementsPath,
      [
        'requests==2.32.0',
        ''
      ].join('\n')
    )
    git(repoDir, ['commit', '-am', 'remove dependency'])
    const headSha = git(repoDir, ['rev-parse', 'HEAD'])

    const result = checkChangedPipRequirements({ baseSha, headSha, cwd: repoDir })

    assert.equal(result.ok, false)
    assert.equal(result.status, 'error')
    assert.deepEqual(result.newDependencies, [])
    assert.deepEqual(result.errors, ['requirements.txt:dependency-removed:django'])
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
})

test('checkChangedPipRequirements treats changed operators markers and extras as manual review', () => {
  const repoDir = initRepo()

  try {
    const requirementsPath = path.join(repoDir, 'requirements.txt')

    writeText(
      requirementsPath,
      [
        'requests==2.31.0',
        'django>=4.2; python_version >= "3.11"',
        'uvicorn[standard]~=0.28.0',
        ''
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
        ''
      ].join('\n')
    )
    git(repoDir, ['commit', '-am', 'change unsupported requirement metadata'])
    const headSha = git(repoDir, ['rev-parse', 'HEAD'])

    const result = checkChangedPipRequirements({ baseSha, headSha, cwd: repoDir })

    assert.equal(result.ok, false)
    assert.equal(result.status, 'error')
    assert.deepEqual(result.newDependencies, [])
    assert.deepEqual(result.errors, [
      'requirements.txt:requirement-variants-changed:django',
      'requirements.txt:requirement-variants-changed:requests',
      'requirements.txt:requirement-variants-changed:uvicorn'
    ])
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
})

test('checkChangedPipRequirements treats changed range requirements as manual review', () => {
  const repoDir = initRepo()

  try {
    const requirementsPath = path.join(repoDir, 'requirements.txt')

    writeText(requirementsPath, 'flask>=2,<3\n')
    git(repoDir, ['add', 'requirements.txt'])
    git(repoDir, ['commit', '-m', 'base'])
    const baseSha = git(repoDir, ['rev-parse', 'HEAD'])

    writeText(requirementsPath, 'flask>=2,<4\n')
    git(repoDir, ['commit', '-am', 'change range'])
    const headSha = git(repoDir, ['rev-parse', 'HEAD'])

    const result = checkChangedPipRequirements({ baseSha, headSha, cwd: repoDir })

    assert.equal(result.ok, false)
    assert.equal(result.status, 'error')
    assert.deepEqual(result.newDependencies, [])
    assert.deepEqual(result.errors, [
      'requirements.txt:unsupported-requirement-removed:flask>=2,<3',
      'requirements.txt:unsupported-requirement-added:flask>=2,<4'
    ])
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
})

test('checkChangedPipRequirements treats removing one of multiple requirement variants as manual review', () => {
  const repoDir = initRepo()

  try {
    const requirementsPath = path.join(repoDir, 'requirements.txt')

    writeText(
      requirementsPath,
      [
        'requests==2.31.0',
        'requests==2.31.0; python_version < "3.12"',
        ''
      ].join('\n')
    )
    git(repoDir, ['add', 'requirements.txt'])
    git(repoDir, ['commit', '-m', 'base'])
    const baseSha = git(repoDir, ['rev-parse', 'HEAD'])

    writeText(
      requirementsPath,
      [
        'requests==2.32.0',
        ''
      ].join('\n')
    )
    git(repoDir, ['commit', '-am', 'remove variant'])
    const headSha = git(repoDir, ['rev-parse', 'HEAD'])

    const result = checkChangedPipRequirements({ baseSha, headSha, cwd: repoDir })

    assert.equal(result.ok, false)
    assert.equal(result.status, 'error')
    assert.deepEqual(result.newDependencies, [])
    assert.deepEqual(result.errors, ['requirements.txt:requirement-variants-changed:requests'])
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
})

test('checkChangedPipRequirements treats newly added complex requirement lines as manual review', () => {
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
        ''
      ].join('\n')
    )
    git(repoDir, ['commit', '-am', 'add complex requirement lines'])
    const headSha = git(repoDir, ['rev-parse', 'HEAD'])

    const result = checkChangedPipRequirements({ baseSha, headSha, cwd: repoDir })

    assert.equal(result.ok, false)
    assert.equal(result.status, 'error')
    assert.deepEqual(result.newDependencies, [])
    assert.deepEqual(result.errors, [
      'requirements.txt:unsupported-requirement-added:barepkg',
      'requirements.txt:unsupported-requirement-added:directpkg @ https://example.com/directpkg.whl',
      'requirements.txt:unsupported-requirement-added:-e git+https://example.com/editable.git#egg=editable',
      'requirements.txt:unsupported-requirement-added:-r other-requirements.txt',
      'requirements.txt:unsupported-requirement-added:--index-url https://example.com/simple',
      'requirements.txt:unsupported-requirement-added:./localpkg',
      'requirements.txt:unsupported-requirement-added:git+https://example.com/vcs.git#egg=vcs'
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

test('checkChangedPipRequirements treats removed complex requirement lines as manual review', () => {
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
    assert.deepEqual(result.errors, ['requirements.txt:unsupported-requirement-removed:--index-url https://example.com/simple'])
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

test('classifyChangedPipFiles rejects ambiguous text files under requirements directories', () => {
  const repoDir = initRepo()

  try {
    const notesPath = path.join(repoDir, 'requirements', 'notes.txt')

    writeText(notesPath, 'notes for humans\n')
    git(repoDir, ['add', 'requirements/notes.txt'])
    git(repoDir, ['commit', '-m', 'base'])
    const baseSha = git(repoDir, ['rev-parse', 'HEAD'])

    writeText(notesPath, 'updated notes for humans\n')
    git(repoDir, ['commit', '-am', 'update notes'])
    const headSha = git(repoDir, ['rev-parse', 'HEAD'])

    const result = classifyChangedPipFiles({ baseSha, headSha, cwd: repoDir })

    assert.deepEqual(result.requirementFiles, [])
    assert.deepEqual(result.unexpectedFiles, ['requirements/notes.txt'])
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
})

test('classifyChangedPipFiles allows valid requirements content in requirements directories', () => {
  const repoDir = initRepo()

  try {
    const requirementsPath = path.join(repoDir, 'requirements', 'dev.txt')

    writeText(requirementsPath, '-r base.txt\n')
    git(repoDir, ['add', 'requirements/dev.txt'])
    git(repoDir, ['commit', '-m', 'base'])
    const baseSha = git(repoDir, ['rev-parse', 'HEAD'])

    writeText(requirementsPath, '-r constraints.txt\n')
    git(repoDir, ['commit', '-am', 'update dev requirements'])
    const headSha = git(repoDir, ['rev-parse', 'HEAD'])

    const result = classifyChangedPipFiles({ baseSha, headSha, cwd: repoDir })

    assert.deepEqual(result.requirementFiles, ['requirements/dev.txt'])
    assert.deepEqual(result.unexpectedFiles, [])
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
})
