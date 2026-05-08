import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { isPipRequirementsFile, listChangedFiles, pathExistsInGitRevision, runGit } from './pr-changes.mjs'

const SIMPLE_REQUIREMENT_PATTERN =
  /^([A-Za-z0-9][A-Za-z0-9._-]*)(\s*\[[A-Za-z0-9._,\-\s]+\])?\s*(===|==|~=|!=|<=|>=|<|>)\s*([^,;\s\\]+)\s*(?:;\s*(.+))?$/

function normalizePackageName(name) {
  return name.toLowerCase().replace(/[-_.]+/g, '-')
}

function normalizeExtras(extras) {
  if (!extras) {
    return ''
  }

  return extras
    .slice(extras.indexOf('[') + 1, extras.lastIndexOf(']'))
    .split(',')
    .map((extra) => normalizePackageName(extra.trim()))
    .filter(Boolean)
    .sort()
    .join(',')
}

function normalizeMarker(marker) {
  return marker ? marker.replace(/\s+/g, ' ').trim() : ''
}

function stripInlineComment(line) {
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '#' && (index === 0 || /\s/.test(line[index - 1]))) {
      return line.slice(0, index).trimEnd()
    }
  }

  return line
}

function complexLine(content, lineNumber, reason) {
  return {
    type: 'complex',
    content: content.replace(/\s+/g, ' ').trim(),
    lineNumber,
    reason,
  }
}

export function parseRequirementLine(line, lineNumber = 1) {
  const content = stripInlineComment(line).trim()

  if (!content) {
    return { type: 'ignored' }
  }

  const lower = content.toLowerCase()

  if (content.endsWith('\\')) {
    return complexLine(content, lineNumber, 'line-continuation')
  }

  if (lower.startsWith('-e ') || lower.startsWith('--editable ')) {
    return complexLine(content, lineNumber, 'editable')
  }

  if (
    lower.startsWith('-r ') ||
    lower.startsWith('--requirement ') ||
    lower.startsWith('-c ') ||
    lower.startsWith('--constraint ')
  ) {
    return complexLine(content, lineNumber, 'include')
  }

  if (content.startsWith('-')) {
    return complexLine(content, lineNumber, 'option')
  }

  if (/^(git|hg|svn|bzr)\+/.test(lower) || /^[a-z][a-z0-9+.-]*:\/\//i.test(content)) {
    return complexLine(content, lineNumber, 'url')
  }

  if (content.startsWith('./') || content.startsWith('../') || content.startsWith('/') || content.startsWith('~/')) {
    return complexLine(content, lineNumber, 'path')
  }

  if (/\s@\s/.test(content)) {
    return complexLine(content, lineNumber, 'direct-reference')
  }

  const match = content.match(SIMPLE_REQUIREMENT_PATTERN)
  if (!match && content.includes(',')) {
    return complexLine(content, lineNumber, 'range')
  }

  if (!match) {
    return complexLine(content, lineNumber, 'unparseable')
  }

  const [, rawName, rawExtras, operator, version, rawMarker] = match
  const name = normalizePackageName(rawName)
  const extras = normalizeExtras(rawExtras)
  const marker = normalizeMarker(rawMarker)

  return {
    type: 'requirement',
    name,
    operator,
    version,
    extras,
    marker,
    key: `${name}|${extras}|${operator}|${marker}`,
    lineNumber,
  }
}

export function extractRequirements(content) {
  const dependencies = new Set()
  const requirementKeysByName = new Map()
  const complexLines = []

  content.split('\n').forEach((line, index) => {
    const parsed = parseRequirementLine(line, index + 1)

    if (parsed.type === 'ignored') {
      return
    }

    if (parsed.type === 'complex') {
      complexLines.push(parsed)
      return
    }

    dependencies.add(parsed.name)

    const keys = requirementKeysByName.get(parsed.name) ?? new Set()
    keys.add(parsed.key)
    requirementKeysByName.set(parsed.name, keys)
  })

  return {
    dependencies,
    requirementKeysByName,
    complexLines,
  }
}

function getErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.replace(/\s+/g, ' ').trim()

  if (normalized.length <= 240) {
    return normalized
  }

  return `${normalized.slice(0, 237)}...`
}

export function findChangedPipRequirementFiles({ baseSha, headSha, changedFiles, cwd = process.cwd() }) {
  const allChangedFiles = changedFiles ?? listChangedFiles({ baseSha, headSha, cwd })

  return {
    changedFiles: allChangedFiles.filter(isPipRequirementsFile),
  }
}

export function checkChangedPipRequirements({ baseSha, headSha, cwd = process.cwd() }) {
  const { changedFiles } = findChangedPipRequirementFiles({ baseSha, headSha, cwd })
  const newDependencies = []
  const errors = []
  const skippedFiles = []

  for (const file of changedFiles) {
    const fullPath = path.join(cwd, file)

    if (!existsSync(fullPath)) {
      skippedFiles.push(`${file}:missing-in-head`)
      continue
    }

    let baseContent
    try {
      baseContent = runGit(['show', `${baseSha}:${file}`], cwd)
    } catch (error) {
      if (!pathExistsInGitRevision({ revision: baseSha, filePath: file, cwd })) {
        errors.push(`${file}:missing-in-base`)
      } else {
        errors.push(`${file}:git-show-failed:${getErrorMessage(error)}`)
      }
      continue
    }

    let headContent
    try {
      headContent = readFileSync(fullPath, 'utf8')
    } catch (error) {
      errors.push(`${file}:read-failed:${error.message}`)
      continue
    }

    const baseRequirements = extractRequirements(baseContent)
    const headRequirements = extractRequirements(headContent)

    for (const dependency of Array.from(headRequirements.dependencies).sort()) {
      if (!baseRequirements.dependencies.has(dependency)) {
        newDependencies.push(`${file}: ${dependency}`)
      }
    }
  }

  let status = 'clear'
  if (changedFiles.length === 0) {
    status = 'no-dependency-files'
  } else if (errors.length > 0) {
    status = 'error'
  } else if (newDependencies.length > 0) {
    status = 'new-dependencies'
  }

  return {
    ok: errors.length === 0 && newDependencies.length === 0,
    status,
    changedFiles,
    skippedFiles,
    newDependencies,
    errors,
  }
}
