import type { ChangedFileContents } from './compare-changed-files.ts'
import { readChangedFile } from './compare-changed-files.ts'
import { compareStrings } from './compare-strings.ts'

export interface ImageReference {
  name: string
  tag: string | null
  digest: string | null
}

export interface ImageReferenceChange {
  file: string
  line: number
  from: ImageReference
  to: ImageReference
}

export interface TrustedImages {
  all: boolean
  repositories: Set<string>
  prefixes: string[]
  invalidEntries: string[]
}

interface ImageReferenceLine {
  reference: ImageReference
  // Everything on the line around the reference. Two versions of a line differ
  // only in the reference exactly when both of these are equal.
  before: string
  after: string
}

const DIGEST = /^sha256:[0-9a-f]{64}$/
const TAG = /^\w[\w.-]{0,127}$/
const FIRST_NAME_COMPONENT = /^[A-Za-z0-9]+(?:[._-]+[A-Za-z0-9]+)*(?::\d+)?$/
const NAME_COMPONENT = /^[a-z0-9]+(?:[._-]+[a-z0-9]+)*$/

// The two places Dependabot rewrites a reference: a Dockerfile FROM line (also
// found inside a compose service's dockerfile_inline) and a compose `image:` key.
const FROM_LINE = /^(?<before>\s*FROM\s+(?:--platform=\S+\s+)?)(?<image>\S+)(?<after>(?:\s+AS\s+\S+)?\s*)$/i
const COMPOSE_IMAGE_LINE = /^(?<before>\s*image:\s*(?<quote>["']?))(?<image>[^\s"'#]+)(?<after>\k<quote>\s*(?:#[^\n]*)?)$/

const DOCKER_HUB = 'docker.io'

function isImageName (name: string): boolean {
  const [first, ...rest] = name.split('/')

  return FIRST_NAME_COMPONENT.test(first) && rest.every(component => NAME_COMPONENT.test(component))
}

// Returns null for anything that is not a literal reference -- most notably a
// `${VARIABLE}`, whose value this check cannot see.
export function parseImageReference (token: string): ImageReference | null {
  let name = token
  let tag: string | null = null
  let digest: string | null = null

  const at = name.indexOf('@')
  if (at !== -1) {
    digest = name.slice(at + 1)
    name = name.slice(0, at)

    if (!DIGEST.test(digest)) {
      return null
    }
  }

  // A colon before the last slash is a registry port, not a tag.
  const colon = name.lastIndexOf(':')
  if (colon > name.lastIndexOf('/')) {
    tag = name.slice(colon + 1)
    name = name.slice(0, colon)

    if (!TAG.test(tag)) {
      return null
    }
  }

  return isImageName(name) ? { name, tag, digest } : null
}

export function formatImageReference ({ name, tag, digest }: ImageReference): string {
  return `${name}${tag === null ? '' : `:${tag}`}${digest === null ? '' : `@${digest}`}`
}

function parseImageReferenceLine (line: string): ImageReferenceLine | null {
  const groups = (FROM_LINE.exec(line) ?? COMPOSE_IMAGE_LINE.exec(line))?.groups

  if (!groups) {
    return null
  }

  const reference = parseImageReference(groups.image)

  return reference ? { reference, before: groups.before, after: groups.after } : null
}

// Follows Docker's own reading of a name: the first component is a registry
// only when it looks like a host, and everything else lives on Docker Hub.
function splitImageName (name: string): { domain: string, path: string[] } {
  const components = name.split('/')
  const first = components[0]
  const hasDomain = components.length > 1
    && (first.includes('.') || first.includes(':') || first === 'localhost' || first !== first.toLowerCase())

  if (!hasDomain) {
    return { domain: DOCKER_HUB, path: components }
  }

  const domain = first.toLowerCase()

  return { domain: domain === 'index.docker.io' ? DOCKER_HUB : domain, path: components.slice(1) }
}

// The same repository can be written as `debian`, `docker.io/debian` or
// `index.docker.io/library/debian`; trust decisions compare this canonical form.
export function normalizeImageName (name: string): string {
  const { domain, path } = splitImageName(name)

  if (domain === DOCKER_HUB && path.length === 1) {
    path.unshift('library')
  }

  return [domain, ...path].join('/')
}

function isRepositoryName (value: string): boolean {
  const reference = parseImageReference(value)

  return reference !== null && reference.tag === null && reference.digest === null
}

export function parseTrustedImages (entries: string[]): TrustedImages {
  const trusted: TrustedImages = { all: false, repositories: new Set(), prefixes: [], invalidEntries: [] }

  for (const entry of entries) {
    if (entry === '*') {
      trusted.all = true
    } else if (entry.endsWith('/*')) {
      // A prefix is only ever followed by more path, so it is read as one with a
      // placeholder appended. That keeps a registry port (localhost:5000/*) from
      // passing for a tag, and stops docker.io/* from collapsing into library/.
      const probe = `${entry.slice(0, -2)}/x`

      if (isRepositoryName(probe)) {
        const { domain, path } = splitImageName(probe)
        trusted.prefixes.push(`${[domain, ...path.slice(0, -1)].join('/')}/`)
      } else {
        trusted.invalidEntries.push(entry)
      }
    } else if (isRepositoryName(entry)) {
      trusted.repositories.add(normalizeImageName(entry))
    } else {
      trusted.invalidEntries.push(entry)
    }
  }

  return trusted
}

export function isTrustedImage (name: string, trusted: TrustedImages): boolean {
  if (trusted.all) {
    return true
  }

  const normalized = normalizeImageName(name)

  return trusted.repositories.has(normalized) || trusted.prefixes.some(prefix => normalized.startsWith(prefix))
}

export function compareImageReferenceFile ({ file, baseContent, headContent }: ChangedFileContents): {
  changes: ImageReferenceChange[]
  violations: string[]
} {
  const baseLines = baseContent.split('\n')
  const headLines = headContent.split('\n')

  // Dependabot rewrites a reference in place, so a different line count already
  // means something other than a reference was edited.
  if (baseLines.length !== headLines.length) {
    return { changes: [], violations: [`${file}:line-count-changed`] }
  }

  const changes: ImageReferenceChange[] = []
  const violations: string[] = []

  for (const [index, baseLine] of baseLines.entries()) {
    const headLine = headLines[index]

    if (baseLine === headLine) {
      continue
    }

    const location = `${file}:${index + 1}`
    const from = parseImageReferenceLine(baseLine)
    const to = parseImageReferenceLine(headLine)

    if (!from || !to) {
      violations.push(`${location}:not-an-image-reference`)
    } else if (from.before !== to.before || from.after !== to.after) {
      violations.push(`${location}:changed-outside-image-reference`)
    } else if (from.reference.name === to.reference.name) {
      changes.push({ file, line: index + 1, from: from.reference, to: to.reference })
    } else {
      // Compared as written, not normalized: even debian -> docker.io/library/debian
      // is a hand edit Dependabot never makes.
      violations.push(`${location}:image-name-changed:${from.reference.name}->${to.reference.name}`)
    }
  }

  return { changes, violations }
}

function imageCheckStatus ({ errors, invalidTrustedImages, violations, unpinnedImages, digestOnlyUpdates, changes, untrustedImages }: {
  errors: string[]
  invalidTrustedImages: string[]
  violations: string[]
  unpinnedImages: string[]
  digestOnlyUpdates: string[]
  changes: ImageReferenceChange[]
  untrustedImages: string[]
}): string {
  if (errors.length > 0) {
    return 'error'
  }

  if (invalidTrustedImages.length > 0) {
    return 'invalid-trusted-images'
  }

  if (violations.length > 0) {
    return 'unexpected-image-change'
  }

  if (unpinnedImages.length > 0) {
    return 'unpinned-image'
  }

  if (digestOnlyUpdates.length > 0) {
    return 'digest-only-update'
  }

  if (changes.length === 0) {
    return 'no-image-changes'
  }

  if (untrustedImages.length > 0) {
    return 'untrusted-image'
  }

  return 'clear'
}

export function checkChangedImageReferences ({ baseSha, changedFiles, trustedImages, cwd = process.cwd() }: {
  baseSha: string
  changedFiles: string[]
  trustedImages: string[]
  cwd?: string
}): {
  ok: boolean
  status: string
  changes: ImageReferenceChange[]
  errors: string[]
  invalidTrustedImages: string[]
  violations: string[]
  unpinnedImages: string[]
  digestOnlyUpdates: string[]
  untrustedImages: string[]
} {
  const trusted = parseTrustedImages(trustedImages)
  const changes: ImageReferenceChange[] = []
  const violations: string[] = []
  const errors: string[] = []

  for (const file of changedFiles) {
    const contents = readChangedFile({ file, baseSha, cwd })

    if ('error' in contents) {
      errors.push(contents.error)
      continue
    }

    const comparison = compareImageReferenceFile(contents)
    changes.push(...comparison.changes)
    violations.push(...comparison.violations)
  }

  // A tag can be moved to different content at any time; only a digest pins it.
  const unpinnedImages = changes
    .filter(change => change.to.digest === null)
    .map(change => `${change.file}:${change.line}: ${formatImageReference(change.to)}`)
  // New content under an unchanged tag is what a re-push produces, and a stolen
  // registry credential is enough for one. Dependabot labels the re-push of a
  // full version tag (1.5.4 -> 1.5.4, new digest) a semver-patch update, so the
  // update-type rule lets it through and only this catches it.
  const digestOnlyUpdates = changes
    .filter(change => change.from.tag === change.to.tag)
    .map(change => `${change.file}:${change.line}: ${formatImageReference(change.to)}`)
  const untrustedImages = [...new Set(
    changes
      .filter(change => !isTrustedImage(change.to.name, trusted))
      .map(change => normalizeImageName(change.to.name))
  )].sort(compareStrings)

  const result = {
    changes,
    errors,
    invalidTrustedImages: trusted.invalidEntries,
    violations,
    unpinnedImages,
    digestOnlyUpdates,
    untrustedImages
  }
  const status = imageCheckStatus(result)

  return { ok: status === 'clear', status, ...result }
}
