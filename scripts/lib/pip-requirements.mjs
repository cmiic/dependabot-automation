import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { isPipRequirementsFile, listChangedFiles, runGit } from './pr-changes.mjs'

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

function addComplexLine(map, complexLine) {
  const lines = map.get(complexLine.content) ?? []
  lines.push(complexLine)
  map.set(complexLine.content, lines)
}

function removeComplexLine(map, content) {
  const lines = map.get(content)

  if (!lines?.length) {
    return null
  }

  const complexLine = lines.shift()

  if (lines.length === 0) {
    map.delete(content)
  }

  return complexLine
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

function isMissingPathInBase(error) {
  const message = getErrorMessage(error)
  return (
    message.includes(' exists on disk, but not in ') ||
    (message.includes("fatal: path '") && message.includes("' does not exist in '"))
  )
}

export function findChangedPipRequirementFiles({ baseSha, headSha, cwd = process.cwd() }) {
  const changedFiles = listChangedFiles({ baseSha, headSha, cwd })

  return {
    changedFiles: changedFiles.filter(isPipRequirementsFile),
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
      errors.push(`${file}:missing-in-head`)
      continue
    }

    let baseContent
    try {
      baseContent = runGit(['show', `${baseSha}:${file}`], cwd)
    } catch (error) {
      if (isMissingPathInBase(error)) {
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
    const unmatchedBaseComplexLines = new Map()

    for (const complexLine of baseRequirements.complexLines) {
      addComplexLine(unmatchedBaseComplexLines, complexLine)
    }

    for (const complexLine of headRequirements.complexLines) {
      if (!removeComplexLine(unmatchedBaseComplexLines, complexLine.content)) {
        errors.push(`${file}:unsupported-requirement:${complexLine.lineNumber}:${complexLine.reason}`)
      }
    }

    for (const complexLines of unmatchedBaseComplexLines.values()) {
      for (const complexLine of complexLines) {
        errors.push(`${file}:unsupported-requirement-removed:${complexLine.lineNumber}:${complexLine.reason}`)
      }
    }

    for (const dependency of Array.from(headRequirements.dependencies).sort()) {
      if (!baseRequirements.dependencies.has(dependency)) {
        newDependencies.push(`${file}: ${dependency}`)
        continue
      }

      const baseKeys = baseRequirements.requirementKeysByName.get(dependency) ?? new Set()
      const headKeys = headRequirements.requirementKeysByName.get(dependency) ?? new Set()

      for (const headKey of headKeys) {
        if (!baseKeys.has(headKey)) {
          errors.push(`${file}:unsupported-requirement-change:${dependency}`)
        }
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
