import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { isPipRequirementsFile, listChangedFiles, pathExistsInGitRevision, runGit } from './pr-changes.mjs'

const SIMPLE_REQUIREMENT_PATTERN =
  /^([A-Za-z0-9][A-Za-z0-9._-]*)(\s*\[[A-Za-z0-9._,\-\s]+\])?\s*(===|==|~=|!=|<=|>=|<|>)\s*([^,;\s\\]+)\s*(?:;\s*(.+))?$/

const PIP_REQUIREMENTS_BASENAME_PATTERN =
  /^(requirements.*|.+-requirements|constraints.*|.+-constraints)\.(txt|in)$/i

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

function findComplexRequirementLineErrors(file, baseComplexLines, headComplexLines) {
  const errors = []
  const unmatchedBaseComplexLines = new Map()

  for (const complexLine of baseComplexLines) {
    addComplexLine(unmatchedBaseComplexLines, complexLine)
  }

  for (const complexLine of headComplexLines) {
    if (!removeComplexLine(unmatchedBaseComplexLines, complexLine.content)) {
      errors.push(`${file}:unsupported-requirement:${complexLine.lineNumber}:${complexLine.reason}`)
    }
  }

  for (const complexLines of unmatchedBaseComplexLines.values()) {
    for (const complexLine of complexLines) {
      errors.push(`${file}:unsupported-requirement-removed:${complexLine.lineNumber}:${complexLine.reason}`)
    }
  }

  return errors
}

function setsDiffer(left, right) {
  if (left.size !== right.size) {
    return true
  }

  for (const item of left) {
    if (!right.has(item)) {
      return true
    }
  }

  return false
}

function normalizePath(filePath) {
  return filePath.replace(/\\/g, '/')
}

function hasRecognizedPipRequirementsBasename(filePath) {
  return PIP_REQUIREMENTS_BASENAME_PATTERN.test(path.basename(normalizePath(filePath)).toLowerCase())
}

function isRequirementsDirectoryFile(filePath) {
  const normalized = normalizePath(filePath)
  return normalized.startsWith('requirements/') || normalized.includes('/requirements/')
}

function isAmbiguousRequirementsDirectoryFile(filePath) {
  const normalized = normalizePath(filePath)
  const basename = path.basename(normalized).toLowerCase()

  if (!/\.(txt|in)$/i.test(basename)) {
    return false
  }

  return isRequirementsDirectoryFile(normalized) && !hasRecognizedPipRequirementsBasename(normalized)
}

function hasRecognizedRequirementContent(content) {
  return content.split('\n').some((line, index) => {
    const parsed = parseRequirementLine(line, index + 1)

    return parsed.type === 'requirement' || (parsed.type === 'complex' && parsed.reason !== 'unparseable')
  })
}

function isSupportedAmbiguousPipFile({ file, baseSha, cwd }) {
  const fullPath = path.join(cwd, file)

  if (existsSync(fullPath)) {
    try {
      if (hasRecognizedRequirementContent(readFileSync(fullPath, 'utf8'))) {
        return true
      }
    } catch {
      return false
    }
  }

  if (!pathExistsInGitRevision({ revision: baseSha, filePath: file, cwd })) {
    return false
  }

  try {
    return hasRecognizedRequirementContent(runGit(['show', `${baseSha}:${file}`], cwd))
  } catch {
    return false
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

export function classifyChangedPipFiles({ baseSha, headSha, changedFiles, cwd = process.cwd() }) {
  const allChangedFiles = changedFiles ?? listChangedFiles({ baseSha, headSha, cwd })
  const unexpectedFiles = []
  const pipChangedFiles = []

  for (const file of allChangedFiles) {
    if (!isPipRequirementsFile(file)) {
      unexpectedFiles.push(file)
      continue
    }

    if (isAmbiguousRequirementsDirectoryFile(file) && !isSupportedAmbiguousPipFile({ file, baseSha, cwd })) {
      unexpectedFiles.push(file)
      continue
    }

    pipChangedFiles.push(file)
  }

  return {
    changedFiles: pipChangedFiles,
    unexpectedFiles,
  }
}

export function findChangedPipRequirementFiles({ baseSha, headSha, changedFiles, cwd = process.cwd() }) {
  const result = classifyChangedPipFiles({ baseSha, headSha, changedFiles, cwd })

  return {
    changedFiles: result.changedFiles,
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
    errors.push(...findComplexRequirementLineErrors(file, baseRequirements.complexLines, headRequirements.complexLines))

    for (const dependency of Array.from(headRequirements.dependencies).sort()) {
      if (!baseRequirements.dependencies.has(dependency)) {
        newDependencies.push(`${file}: ${dependency}`)
        continue
      }

      const baseKeys = baseRequirements.requirementKeysByName.get(dependency) ?? new Set()
      const headKeys = headRequirements.requirementKeysByName.get(dependency) ?? new Set()

      if (setsDiffer(baseKeys, headKeys)) {
        errors.push(`${file}:unsupported-requirement-change:${dependency}`)
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
