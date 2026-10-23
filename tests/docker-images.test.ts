import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  checkChangedImageReferences,
  compareImageReferenceFile,
  formatImageReference,
  isTrustedImage,
  normalizeImageName,
  parseImageReference,
  parseTrustedImages
} from '../src/lib/docker-images.ts'

const OLD_DIGEST = `sha256:${'a'.repeat(64)}`
const NEW_DIGEST = `sha256:${'b'.repeat(64)}`
const IMGPROXY_OLD = `docker.io/darthsim/imgproxy:v4.0.16@${OLD_DIGEST}`
const IMGPROXY_NEW = `docker.io/darthsim/imgproxy:v4.0.17@${NEW_DIGEST}`
const CLAMAV_OLD = `docker.io/clamav/clamav:1.5.3-debian13-slim@${OLD_DIGEST}`
const CLAMAV_NEW = `docker.io/clamav/clamav:1.5.4-debian13-slim@${NEW_DIGEST}`

function git (cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function writeFiles (repoDir: string, files: Record<string, string>): void {
  for (const [file, content] of Object.entries(files)) {
    const fullPath = path.join(repoDir, file)
    mkdirSync(path.dirname(fullPath), { recursive: true })
    writeFileSync(fullPath, content)
  }
}

// Commits `files` as the base revision and hands the checkout to `run`, which
// writes the head versions into the working tree: that is where the check reads
// them from, as it does on the PR head checkout in CI.
function withRepo (files: Record<string, string>, run: (repoDir: string, baseSha: string) => void): void {
  const repoDir = mkdtempSync(path.join(tmpdir(), 'dependabot-automation-docker-images-'))

  try {
    git(repoDir, ['init'])
    git(repoDir, ['config', 'user.name', 'Codex'])
    git(repoDir, ['config', 'user.email', 'codex@example.com'])
    writeFiles(repoDir, files)
    git(repoDir, ['add', '-A'])
    git(repoDir, ['commit', '-m', 'base'])

    run(repoDir, git(repoDir, ['rev-parse', 'HEAD']))
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
}

// Shaped after a real compose.dev.yaml: a plain `image:` key, and a quoted one
// with a trailing comment.
function composeFile ({ imgproxy = IMGPROXY_OLD, clamav = CLAMAV_OLD, readOnly = 'true' } = {}): string {
  return [
    'services:',
    '  imgproxy:',
    `    image: ${imgproxy}`,
    `    read_only: ${readOnly}`,
    '  clamav:',
    `    image: "${clamav}" # scanner`,
    '    environment:',
    '      CLAMAV_STREAM_MAX_LENGTH: 220M',
    ''
  ].join('\n')
}

function dockerfile ({
  builder = `docker.io/library/golang:1.27.0-trixie@${OLD_DIGEST}`,
  runtime = `docker.io/library/debian:13.6-slim@${OLD_DIGEST}`,
  stage = 'builder',
  build = 'RUN go build ./...'
} = {}): string {
  return [
    `FROM --platform=$BUILDPLATFORM ${builder} AS ${stage}`,
    build,
    '',
    `FROM ${runtime}`,
    'COPY --from=builder /out/app /app',
    ''
  ].join('\n')
}

function compareCompose (head: Parameters<typeof composeFile>[0]): ReturnType<typeof compareImageReferenceFile> {
  return compareImageReferenceFile({
    file: 'compose.dev.yaml',
    baseContent: composeFile(),
    headContent: composeFile(head)
  })
}

test('parseImageReference splits name, tag and digest', () => {
  assert.deepEqual(parseImageReference('debian'), { name: 'debian', tag: null, digest: null })
  assert.deepEqual(parseImageReference(CLAMAV_NEW), {
    name: 'docker.io/clamav/clamav',
    tag: '1.5.4-debian13-slim',
    digest: NEW_DIGEST
  })
  assert.deepEqual(parseImageReference(`debian@${OLD_DIGEST}`), { name: 'debian', tag: null, digest: OLD_DIGEST })
})

test('parseImageReference reads a colon before the last slash as a registry port', () => {
  assert.deepEqual(parseImageReference('localhost:5000/team/app'), {
    name: 'localhost:5000/team/app',
    tag: null,
    digest: null
  })
  assert.deepEqual(parseImageReference('localhost:5000/team/app:1.2'), {
    name: 'localhost:5000/team/app',
    tag: '1.2',
    digest: null
  })
})

test('parseImageReference rejects variables and malformed references', () => {
  for (const token of [
    '',
    '${BASE_IMAGE}',
    'debian:${TAG}',
    `$REGISTRY/debian@${OLD_DIGEST}`,
    'debian:',
    'debian@sha256:abc',
    `debian@sha512:${'a'.repeat(128)}`,
    `debian@${OLD_DIGEST}@${NEW_DIGEST}`,
    'team//app',
    'team/App',
    '/debian'
  ]) {
    assert.equal(parseImageReference(token), null, token)
  }
})

test('formatImageReference writes back what parseImageReference read', () => {
  for (const token of ['debian', 'debian:13.7-slim', `debian@${OLD_DIGEST}`, CLAMAV_NEW, 'localhost:5000/team/app:1.2']) {
    const reference = parseImageReference(token)
    assert.ok(reference, token)
    assert.equal(formatImageReference(reference), token)
  }
})

test('normalizeImageName resolves names the way Docker does', () => {
  const cases: Array<[string, string]> = [
    ['debian', 'docker.io/library/debian'],
    ['docker.io/debian', 'docker.io/library/debian'],
    ['index.docker.io/library/debian', 'docker.io/library/debian'],
    ['clamav/clamav', 'docker.io/clamav/clamav'],
    ['GHCR.io/imgproxy/imgproxy', 'ghcr.io/imgproxy/imgproxy'],
    ['localhost/app', 'localhost/app'],
    ['localhost:5000/team/app', 'localhost:5000/team/app'],
    ['localhost', 'docker.io/library/localhost']
  ]

  for (const [name, expected] of cases) {
    assert.equal(normalizeImageName(name), expected, name)
  }
})

test('parseTrustedImages trusts an exact repository under every spelling of it', () => {
  const trusted = parseTrustedImages(['debian'])

  assert.deepEqual(trusted.invalidEntries, [])
  assert.equal(isTrustedImage('debian', trusted), true)
  assert.equal(isTrustedImage('docker.io/library/debian', trusted), true)
  assert.equal(isTrustedImage('index.docker.io/library/debian', trusted), true)
  assert.equal(isTrustedImage('debian-slim', trusted), false)
  assert.equal(isTrustedImage('docker.io/other/debian', trusted), false)
})

test('parseTrustedImages trusts every repository below a prefix', () => {
  const trusted = parseTrustedImages(['ghcr.io/cmiic/*'])

  assert.equal(isTrustedImage('ghcr.io/cmiic/app', trusted), true)
  assert.equal(isTrustedImage('ghcr.io/cmiic/team/app', trusted), true)
  assert.equal(isTrustedImage('GHCR.IO/cmiic/app', trusted), true)
  assert.equal(isTrustedImage('ghcr.io/cmiic-evil/app', trusted), false)
  assert.equal(isTrustedImage('ghcr.io/other/app', trusted), false)
})

test('parseTrustedImages keeps a registry-wide prefix out of library/', () => {
  const dockerHub = parseTrustedImages(['docker.io/*'])
  assert.equal(isTrustedImage('debian', dockerHub), true)
  assert.equal(isTrustedImage('clamav/clamav', dockerHub), true)
  assert.equal(isTrustedImage('ghcr.io/imgproxy/imgproxy', dockerHub), false)

  const localRegistry = parseTrustedImages(['localhost:5000/*'])
  assert.deepEqual(localRegistry.invalidEntries, [])
  assert.equal(isTrustedImage('localhost:5000/app', localRegistry), true)
  assert.equal(isTrustedImage('localhost/app', localRegistry), false)
})

test('parseTrustedImages trusts everything for * and nothing for an empty list', () => {
  assert.equal(isTrustedImage('clamav/clamav', parseTrustedImages(['*'])), true)
  assert.equal(isTrustedImage('clamav/clamav', parseTrustedImages([])), false)
})

test('parseTrustedImages reports entries with a tag, a digest or a misplaced wildcard', () => {
  const entries = ['debian:13', `debian@${OLD_DIGEST}`, 'ghcr.io/*/app', 'ghcr.io/cmiic*', 'team//app', '*/*']
  const trusted = parseTrustedImages([...entries, 'ghcr.io/cmiic/app'])

  assert.deepEqual(trusted.invalidEntries, entries)
  assert.equal(trusted.all, false)
  assert.deepEqual([...trusted.repositories], ['ghcr.io/cmiic/app'])
  assert.deepEqual(trusted.prefixes, [])
})

test('compareImageReferenceFile accepts tag and digest bumps in compose files', () => {
  const result = compareCompose({ imgproxy: IMGPROXY_NEW, clamav: CLAMAV_NEW })

  assert.deepEqual(result.violations, [])
  assert.deepEqual(result.changes, [
    { file: 'compose.dev.yaml', line: 3, from: parseImageReference(IMGPROXY_OLD), to: parseImageReference(IMGPROXY_NEW) },
    { file: 'compose.dev.yaml', line: 6, from: parseImageReference(CLAMAV_OLD), to: parseImageReference(CLAMAV_NEW) }
  ])
})

test('compareImageReferenceFile rejects a changed repository, even with the same digest', () => {
  const result = compareCompose({ imgproxy: `ghcr.io/imgproxy/imgproxy:v4.0.16@${OLD_DIGEST}` })

  assert.deepEqual(result.changes, [])
  assert.deepEqual(result.violations, [
    'compose.dev.yaml:3:image-name-changed:docker.io/darthsim/imgproxy->ghcr.io/imgproxy/imgproxy'
  ])
})

test('compareImageReferenceFile compares names as written', () => {
  const result = compareImageReferenceFile({
    file: 'Dockerfile',
    baseContent: `FROM debian:13.6-slim@${OLD_DIGEST}\n`,
    headContent: `FROM docker.io/library/debian:13.7-slim@${NEW_DIGEST}\n`
  })

  assert.deepEqual(result.violations, ['Dockerfile:1:image-name-changed:debian->docker.io/library/debian'])
})

test('compareImageReferenceFile rejects edits around the reference', () => {
  const quoteRemoved = compareImageReferenceFile({
    file: 'compose.dev.yaml',
    baseContent: composeFile(),
    headContent: composeFile().replace(`"${CLAMAV_OLD}"`, CLAMAV_NEW)
  })
  assert.deepEqual(quoteRemoved.violations, ['compose.dev.yaml:6:changed-outside-image-reference'])

  const stageRenamed = compareImageReferenceFile({
    file: 'Dockerfile',
    baseContent: dockerfile(),
    headContent: dockerfile({ stage: 'build' })
  })
  assert.deepEqual(stageRenamed.violations, ['Dockerfile:1:changed-outside-image-reference'])
})

test('compareImageReferenceFile rejects changed lines that are not image references', () => {
  assert.deepEqual(compareCompose({ readOnly: 'false' }).violations, ['compose.dev.yaml:4:not-an-image-reference'])

  const result = compareImageReferenceFile({
    file: 'Dockerfile',
    baseContent: dockerfile(),
    headContent: dockerfile({ build: 'RUN curl -sSf https://example.com/install.sh | sh' })
  })
  assert.deepEqual(result.violations, ['Dockerfile:2:not-an-image-reference'])
})

test('compareImageReferenceFile rejects a reference replaced by a variable', () => {
  assert.deepEqual(compareCompose({ imgproxy: '${IMGPROXY_IMAGE}' }).violations, [
    'compose.dev.yaml:3:not-an-image-reference'
  ])
})

test('compareImageReferenceFile rejects a changed line count', () => {
  const result = compareImageReferenceFile({
    file: 'compose.dev.yaml',
    baseContent: composeFile(),
    headContent: `${composeFile({ imgproxy: IMGPROXY_NEW })}    command: ["sh", "-c", "id"]\n`
  })

  assert.deepEqual(result, { changes: [], violations: ['compose.dev.yaml:line-count-changed'] })
})

test('compareImageReferenceFile reads FROM lines with --platform and AS', () => {
  const builder = `docker.io/library/golang:1.27.1-trixie@${NEW_DIGEST}`
  const runtime = `docker.io/library/debian:13.7-slim@${NEW_DIGEST}`
  const result = compareImageReferenceFile({
    file: 'Dockerfile',
    baseContent: dockerfile(),
    headContent: dockerfile({ builder, runtime })
  })

  assert.deepEqual(result.violations, [])
  assert.deepEqual(result.changes.map(change => [change.line, formatImageReference(change.to)]), [
    [1, builder],
    [4, runtime]
  ])
})

test('compareImageReferenceFile reads FROM lines inside a compose dockerfile_inline block', () => {
  const inline = (image: string): string => [
    'services:',
    '  app:',
    '    build:',
    '      dockerfile_inline: |',
    `        FROM ${image}`,
    '        RUN true',
    ''
  ].join('\n')
  const result = compareImageReferenceFile({
    file: 'compose.yaml',
    baseContent: inline(`debian:13.6-slim@${OLD_DIGEST}`),
    headContent: inline(`debian:13.7-slim@${NEW_DIGEST}`)
  })

  assert.deepEqual(result.violations, [])
  assert.deepEqual(result.changes.map(change => change.line), [5])
})

test('checkChangedImageReferences clears pinned bumps of trusted images', () => {
  withRepo({ 'compose.dev.yaml': composeFile(), 'Dockerfile': dockerfile() }, (repoDir, baseSha) => {
    writeFiles(repoDir, {
      'compose.dev.yaml': composeFile({ imgproxy: IMGPROXY_NEW }),
      'Dockerfile': dockerfile({ runtime: `docker.io/library/debian:13.7-slim@${NEW_DIGEST}` })
    })

    const result = checkChangedImageReferences({
      baseSha,
      changedFiles: ['compose.dev.yaml', 'Dockerfile'],
      trustedImages: ['docker.io/darthsim/imgproxy', 'docker.io/library/*'],
      cwd: repoDir
    })

    assert.equal(result.status, 'clear')
    assert.equal(result.ok, true)
    assert.equal(result.changes.length, 2)
    assert.deepEqual(
      [result.errors, result.invalidTrustedImages, result.violations, result.unpinnedImages, result.digestOnlyUpdates, result.untrustedImages],
      [[], [], [], [], [], []]
    )
  })
})

test('checkChangedImageReferences rejects images missing from trusted-images, which is empty by default', () => {
  withRepo({ 'compose.dev.yaml': composeFile() }, (repoDir, baseSha) => {
    writeFiles(repoDir, { 'compose.dev.yaml': composeFile({ imgproxy: IMGPROXY_NEW, clamav: CLAMAV_NEW }) })

    const byDefault = checkChangedImageReferences({ baseSha, changedFiles: ['compose.dev.yaml'], trustedImages: [], cwd: repoDir })
    assert.equal(byDefault.status, 'untrusted-image')
    assert.equal(byDefault.ok, false)
    assert.deepEqual(byDefault.untrustedImages, ['docker.io/clamav/clamav', 'docker.io/darthsim/imgproxy'])

    const partly = checkChangedImageReferences({
      baseSha,
      changedFiles: ['compose.dev.yaml'],
      trustedImages: ['darthsim/imgproxy'],
      cwd: repoDir
    })
    assert.equal(partly.status, 'untrusted-image')
    assert.deepEqual(partly.untrustedImages, ['docker.io/clamav/clamav'])
  })
})

test('checkChangedImageReferences rejects a reference that loses its digest', () => {
  withRepo({ 'compose.dev.yaml': composeFile() }, (repoDir, baseSha) => {
    writeFiles(repoDir, { 'compose.dev.yaml': composeFile({ imgproxy: 'docker.io/darthsim/imgproxy:v4.0.17' }) })

    const result = checkChangedImageReferences({ baseSha, changedFiles: ['compose.dev.yaml'], trustedImages: ['*'], cwd: repoDir })

    assert.equal(result.status, 'unpinned-image')
    assert.deepEqual(result.unpinnedImages, ['compose.dev.yaml:3: docker.io/darthsim/imgproxy:v4.0.17'])
  })
})

test('checkChangedImageReferences rejects a re-pushed tag, versioned or floating', () => {
  withRepo({ 'compose.dev.yaml': composeFile({ imgproxy: `docker.io/darthsim/imgproxy:latest@${OLD_DIGEST}` }) }, (repoDir, baseSha) => {
    const repushedVersion = `docker.io/clamav/clamav:1.5.3-debian13-slim@${NEW_DIGEST}`
    const repushedLatest = `docker.io/darthsim/imgproxy:latest@${NEW_DIGEST}`
    writeFiles(repoDir, { 'compose.dev.yaml': composeFile({ imgproxy: repushedLatest, clamav: repushedVersion }) })

    const result = checkChangedImageReferences({ baseSha, changedFiles: ['compose.dev.yaml'], trustedImages: ['*'], cwd: repoDir })

    assert.equal(result.status, 'digest-only-update')
    assert.deepEqual(result.digestOnlyUpdates, [
      `compose.dev.yaml:3: ${repushedLatest}`,
      `compose.dev.yaml:6: ${repushedVersion}`
    ])
  })
})

test('checkChangedImageReferences reports an unexpected change ahead of an untrusted image', () => {
  withRepo({ 'compose.dev.yaml': composeFile() }, (repoDir, baseSha) => {
    writeFiles(repoDir, {
      'compose.dev.yaml': composeFile({ imgproxy: `ghcr.io/imgproxy/imgproxy:v4.0.17@${NEW_DIGEST}`, clamav: CLAMAV_NEW })
    })

    const result = checkChangedImageReferences({ baseSha, changedFiles: ['compose.dev.yaml'], trustedImages: [], cwd: repoDir })

    assert.equal(result.status, 'unexpected-image-change')
    assert.deepEqual(result.violations, [
      'compose.dev.yaml:3:image-name-changed:docker.io/darthsim/imgproxy->ghcr.io/imgproxy/imgproxy'
    ])
    assert.deepEqual(result.untrustedImages, ['docker.io/clamav/clamav'])
  })
})

test('checkChangedImageReferences treats a file added by the pull request as an error', () => {
  withRepo({ 'compose.dev.yaml': composeFile() }, (repoDir, baseSha) => {
    writeFiles(repoDir, {
      'compose.dev.yaml': composeFile({ imgproxy: IMGPROXY_NEW }),
      'compose.override.yaml': composeFile()
    })

    const result = checkChangedImageReferences({
      baseSha,
      changedFiles: ['compose.dev.yaml', 'compose.override.yaml'],
      trustedImages: ['*'],
      cwd: repoDir
    })

    assert.equal(result.status, 'error')
    assert.deepEqual(result.errors, ['compose.override.yaml:missing-in-base'])
    assert.equal(result.changes.length, 1)
  })
})

test('checkChangedImageReferences rejects every update while trusted-images has an invalid entry', () => {
  withRepo({ 'compose.dev.yaml': composeFile() }, (repoDir, baseSha) => {
    writeFiles(repoDir, { 'compose.dev.yaml': composeFile({ imgproxy: IMGPROXY_NEW }) })

    const result = checkChangedImageReferences({
      baseSha,
      changedFiles: ['compose.dev.yaml'],
      trustedImages: ['docker.io/darthsim/imgproxy', 'debian:13'],
      cwd: repoDir
    })

    assert.equal(result.status, 'invalid-trusted-images')
    assert.deepEqual(result.invalidTrustedImages, ['debian:13'])
  })
})

test('checkChangedImageReferences reports no-image-changes when nothing was compared', () => {
  const result = checkChangedImageReferences({ baseSha: 'HEAD', changedFiles: [], trustedImages: ['*'] })

  assert.equal(result.status, 'no-image-changes')
  assert.equal(result.ok, false)
})
