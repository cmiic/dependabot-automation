import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { ChangedFileComparison, ChangedFileContents } from '../src/lib/compare-changed-files.ts'
import { compareChangedFiles, getErrorMessage } from '../src/lib/compare-changed-files.ts'

function git (cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

/**
 * A repository with the file committed twice, so the base revision holds one
 * version and the working tree another. gc.auto is off so the objects stay
 * loose -- the git-show-failed test below reaches into them by path.
 */
function createFixture (fileNames: [string, ...string[]] = ['package-lock.json']): { repoDir: string, baseSha: string, filePath: string } {
  const repoDir = mkdtempSync(path.join(tmpdir(), 'dependabot-automation-compare-'))

  git(repoDir, ['init'])
  git(repoDir, ['config', 'user.name', 'Codex'])
  git(repoDir, ['config', 'user.email', 'codex@example.com'])
  git(repoDir, ['config', 'gc.auto', '0'])

  const write = (contents: string): void => {
    for (const fileName of fileNames) {
      writeFileSync(path.join(repoDir, fileName), contents)
    }
  }

  write('base\n')
  git(repoDir, ['add', '-A'])
  git(repoDir, ['commit', '-m', 'base'])
  const baseSha = git(repoDir, ['rev-parse', 'HEAD'])

  write('head\n')
  git(repoDir, ['add', '-A'])
  git(repoDir, ['commit', '-m', 'head'])

  return { repoDir, baseSha, filePath: path.join(repoDir, fileNames[0]) }
}

/** Records what it was handed, so a test can assert the contents reached it. */
function collectContents (seen: ChangedFileContents[]): (contents: ChangedFileContents) => ChangedFileComparison {
  return (contents) => {
    seen.push(contents)

    return { newDependencies: [`${contents.file}: dep`], errors: [] }
  }
}

const noComparison = (): ChangedFileComparison => ({ newDependencies: [], errors: [] })

test('getErrorMessage collapses whitespace and leaves short messages alone', () => {
  assert.equal(getErrorMessage(new Error('a\n\n   b\tc  ')), 'a b c')
  assert.equal(getErrorMessage(new Error('plain')), 'plain')
})

test('getErrorMessage stringifies values that are not Errors', () => {
  assert.equal(getErrorMessage('just a string'), 'just a string')
  assert.equal(getErrorMessage(42), '42')
  assert.equal(getErrorMessage(null), 'null')
})

test('getErrorMessage truncates a long message to 240 characters', () => {
  // A git or parser failure must not be able to flood a GitHub Actions output.
  const truncated = getErrorMessage(new Error('a'.repeat(300)))

  assert.equal(truncated.length, 240)
  assert.ok(truncated.endsWith('...'), 'expected an ellipsis on a truncated message')
  assert.equal(truncated, `${'a'.repeat(237)}...`)
})

test('getErrorMessage leaves a message of exactly the limit untouched', () => {
  const exact = 'a'.repeat(240)

  assert.equal(getErrorMessage(new Error(exact)), exact)
  assert.equal(getErrorMessage(new Error('a'.repeat(241))).length, 240)
})

test('compareChangedFiles hands both revisions to the comparison callback', () => {
  const { repoDir, baseSha } = createFixture()

  try {
    const seen: ChangedFileContents[] = []
    const result = compareChangedFiles({
      files: ['package-lock.json'],
      baseSha,
      cwd: repoDir,
      compare: collectContents(seen)
    })

    assert.deepEqual(seen, [{ file: 'package-lock.json', baseContent: 'base\n', headContent: 'head\n' }])
    assert.deepEqual(result, { newDependencies: ['package-lock.json: dep'], errors: [] })
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
})

test('compareChangedFiles reports a file that is gone from the working tree', () => {
  const { repoDir, baseSha, filePath } = createFixture()

  try {
    rmSync(filePath)

    const result = compareChangedFiles({
      files: ['package-lock.json'],
      baseSha,
      cwd: repoDir,
      compare: noComparison
    })

    assert.deepEqual(result.errors, ['package-lock.json:missing-in-head'])
    assert.deepEqual(result.newDependencies, [])
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
})

test('compareChangedFiles reports a file the pull request added', () => {
  const { repoDir, baseSha } = createFixture()

  try {
    writeFileSync(path.join(repoDir, 'added.json'), 'new\n')

    const result = compareChangedFiles({
      files: ['added.json'],
      baseSha,
      cwd: repoDir,
      compare: noComparison
    })

    assert.deepEqual(result.errors, ['added.json:missing-in-base'])
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
})

test('compareChangedFiles distinguishes a git failure from a file added in the pull request', () => {
  const { repoDir, baseSha } = createFixture()

  try {
    // Delete the blob the base revision points at, keeping the tree that names
    // it. git ls-tree reads only the tree, so the path still resolves and the
    // file does not look added -- but git show cannot produce the content.
    // This is the one way to reach git-show-failed rather than missing-in-base.
    const blob = git(repoDir, ['rev-parse', `${baseSha}:package-lock.json`])
    // Ask git where the object store is rather than assuming .git/objects: an
    // alternate object directory, an alternates file or a worktree all move it.
    // The answer may be relative to the repository, so resolve it from there.
    const objectsDir = path.resolve(repoDir, git(repoDir, ['rev-parse', '--git-path', 'objects']))
    const objectPath = path.join(objectsDir, blob.slice(0, 2), blob.slice(2))

    // If the object were packed instead of loose, removing this path would be a
    // no-op and the test would pass without ever reaching the branch.
    assert.ok(existsSync(objectPath), `expected a loose object at ${objectPath}`)
    rmSync(objectPath, { force: true })

    const result = compareChangedFiles({
      files: ['package-lock.json'],
      baseSha,
      cwd: repoDir,
      compare: noComparison
    })

    assert.equal(result.errors.length, 1)
    // Only the prefix is pinned: the git text after it varies by version and platform.
    assert.match(result.errors[0], /^package-lock\.json:git-show-failed:.+/)
    assert.doesNotMatch(result.errors[0], /missing-in-base/)
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
})

test('compareChangedFiles reports a head file it cannot read', () => {
  const { repoDir, baseSha, filePath } = createFixture()

  try {
    // A directory in place of the file: existsSync still passes, git show still
    // resolves the base revision, and readFileSync fails with EISDIR.
    rmSync(filePath)
    mkdirSync(filePath)

    const result = compareChangedFiles({
      files: ['package-lock.json'],
      baseSha,
      cwd: repoDir,
      compare: noComparison
    })

    assert.equal(result.errors.length, 1)
    assert.match(result.errors[0], /^package-lock\.json:read-failed:.+/)
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
})

test('compareChangedFiles keeps going after a failing file and preserves order', () => {
  const { repoDir, baseSha } = createFixture(['package-lock.json', 'second.json'])

  try {
    const result = compareChangedFiles({
      // The middle file exists in neither revision; the other two are fine.
      files: ['package-lock.json', 'gone.json', 'second.json'],
      baseSha,
      cwd: repoDir,
      compare: ({ file }) => ({
        newDependencies: [`${file}: dep`],
        errors: file === 'second.json' ? [`${file}:comparison-complained`] : []
      })
    })

    assert.deepEqual(result.newDependencies, ['package-lock.json: dep', 'second.json: dep'])
    // gone.json fails the working-tree check before git is consulted at all, so
    // it is missing-in-head rather than missing-in-base. Its error and the one
    // the callback returned for the third file land in the order given.
    assert.deepEqual(result.errors, ['gone.json:missing-in-head', 'second.json:comparison-complained'])
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
})

test('compareChangedFiles returns empty results for an empty file list', () => {
  const { repoDir, baseSha } = createFixture()

  try {
    assert.deepEqual(
      compareChangedFiles({ files: [], baseSha, cwd: repoDir, compare: noComparison }),
      { newDependencies: [], errors: [] }
    )
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
})
