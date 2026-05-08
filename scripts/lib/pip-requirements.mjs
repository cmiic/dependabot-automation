import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { isPipRequirementsFile, listChangedFiles, pathExistsInGitRevision, runGit } from './pr-changes.mjs'

const SIMPLE_REQUIREMENT_PATTERN
  = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\s*\[[A-Za-z0-9._,\-\s]+\])?\s*(===|==|~=|!=|<=|>=|<|>)\s*([^,;\s\\]+)\s*(?:;\s*(.+))?$/

function normalizePackageName (name) {
  return name.toLowerCase().replace(/[-_.]+/g, '-')
}

function normalizeExtras (extras) {
  if (!extras) {
    return ''
  }

  return extras
    .slice(extras.indexOf('[') + 1, extras.lastIndexOf(']'))
    .split(',')
    .map(extra => normalizePackageName(extra.trim()))
    .filter(Boolean)
    .sort()
    .join(',')
}

function normalizeMarker (marker) {
  return marker ? marker.replace(/\s+/g, ' ').trim() : ''
}

function normalizePath (filePath) {
  return filePath.replace(/\\/g, '/')
}

function isNamedPipRequirementsFile (filePath) {
  const basename = path.basename(normalizePath(filePath)).toLowerCase()

  if (!/\.(txt|in)$/i.test(basename)) {
    return false
  }

  return (
    /^requirements.*\.(txt|in)$/i.test(basename)
    || /^.+-requirements\.(txt|in)$/i.test(basename)
    || /^constraints.*\.(txt|in)$/i.test(basename)
    || /^.+-constraints\.(txt|in)$/i.test(basename)
  )
}

function isAmbiguousRequirementsDirectoryFile (filePath) {
  const normalized = normalizePath(filePath)
  const basename = path.basename(normalized).toLowerCase()

  return (
    /\.(txt|in)$/i.test(basename)
    && (normalized.startsWith('requirements/') || normalized.includes('/requirements/'))
    && !isNamedPipRequirementsFile(filePath)
  )
}

function stripInlineComment (line) {
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '#' && (index === 0 || /\s/.test(line[index - 1]))) {
      return line.slice(0, index).trimEnd()
    }
  }

  return line
}

function complexLine (content, lineNumber, reason) {
  return {
    type: 'complex',
    content: content.replace(/\s+/g, ' ').trim(),
    lineNumber,
    reason
  }
}

export function parseRequirementLine (line, lineNumber = 1) {
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
    lower.startsWith('-r ')
    || lower.startsWith('--requirement ')
    || lower.startsWith('-c ')
    || lower.startsWith('--constraint ')
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

  if (!match && /^[A-Za-z0-9][A-Za-z0-9._-]*(\s*\[[A-Za-z0-9._,\-\s]+\])?\s*(?:;\s*.+)?$/.test(content)) {
    return complexLine(content, lineNumber, 'bare-specifier')
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
    lineNumber
  }
}

export function extractRequirements (content) {
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
    complexLines
  }
}

function setEquals (left, right) {
  if (left.size !== right.size) {
    return false
  }

  for (const value of left) {
    if (!right.has(value)) {
      return false
    }
  }

  return true
}

function buildComplexLineMap (lines) {
  const complexLineMap = new Map()

  for (const line of lines) {
    const key = `${line.reason}|${line.content}`
    const entry = complexLineMap.get(key) ?? { count: 0, line }
    entry.count += 1
    complexLineMap.set(key, entry)
  }

  return complexLineMap
}

function findComplexRequirementLineErrors ({ file, baseRequirements, headRequirements }) {
  const errors = []
  const baseComplexLines = buildComplexLineMap(baseRequirements.complexLines)
  const headComplexLines = buildComplexLineMap(headRequirements.complexLines)
  const keys = new Set([...baseComplexLines.keys(), ...headComplexLines.keys()])

  for (const key of Array.from(keys).sort()) {
    const baseEntry = baseComplexLines.get(key)
    const headEntry = headComplexLines.get(key)
    const baseCount = baseEntry?.count ?? 0
    const headCount = headEntry?.count ?? 0

    if (baseCount === headCount) {
      continue
    }

    const descriptor = headEntry?.line ?? baseEntry.line

    for (let index = 0; index < Math.max(baseCount - headCount, 0); index += 1) {
      errors.push(`${file}:unsupported-requirement-removed:${descriptor.content}`)
    }

    for (let index = 0; index < Math.max(headCount - baseCount, 0); index += 1) {
      errors.push(`${file}:unsupported-requirement-added:${descriptor.content}`)
    }
  }

  return errors
}

function isRecognizedRequirementsContent (content) {
  return content
    .split('\n')
    .map((line, index) => parseRequirementLine(line, index + 1))
    .every(parsed => parsed.type !== 'complex' || parsed.reason !== 'unparseable')
}

function loadAvailableChangedFileContents ({ baseSha, file, cwd }) {
  const contents = []

  if (pathExistsInGitRevision({ revision: baseSha, filePath: file, cwd })) {
    try {
      contents.push(runGit(['show', `${baseSha}:${file}`], cwd))
    } catch {
      return null
    }
  }

  const fullPath = path.join(cwd, file)
  if (existsSync(fullPath)) {
    try {
      contents.push(readFileSync(fullPath, 'utf8'))
    } catch {
      return null
    }
  }

  return contents
}

export function classifyChangedPipFiles ({ baseSha, headSha, changedFiles, cwd = process.cwd() }) {
  const allChangedFiles = changedFiles ?? listChangedFiles({ baseSha, headSha, cwd })
  const requirementFiles = []
  const unexpectedFiles = []

  for (const file of allChangedFiles) {
    if (!isPipRequirementsFile(file)) {
      unexpectedFiles.push(file)
      continue
    }

    if (!isAmbiguousRequirementsDirectoryFile(file)) {
      requirementFiles.push(file)
      continue
    }

    const contents = loadAvailableChangedFileContents({ baseSha, file, cwd })

    if (!contents || contents.every(isRecognizedRequirementsContent)) {
      requirementFiles.push(file)
      continue
    }

    unexpectedFiles.push(file)
  }

  return {
    requirementFiles,
    unexpectedFiles
  }
}

function getErrorMessage (error) {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.replace(/\s+/g, ' ').trim()

  if (normalized.length <= 240) {
    return normalized
  }

  return `${normalized.slice(0, 237)}...`
}

export function findChangedPipRequirementFiles ({ baseSha, headSha, changedFiles, cwd = process.cwd() }) {
  const allChangedFiles = changedFiles ?? listChangedFiles({ baseSha, headSha, cwd })

  return {
    changedFiles: allChangedFiles.filter(isPipRequirementsFile)
  }
}

export function checkChangedPipRequirements ({ baseSha, headSha, changedFiles, cwd = process.cwd() }) {
  const { changedFiles: requirementFiles } = findChangedPipRequirementFiles({ baseSha, headSha, changedFiles, cwd })
  const newDependencies = []
  const errors = []
  const skippedFiles = []

  for (const file of requirementFiles) {
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
    errors.push(...findComplexRequirementLineErrors({ file, baseRequirements, headRequirements }))

    const dependencyNames = new Set([
      ...baseRequirements.dependencies,
      ...headRequirements.dependencies
    ])

    for (const dependency of Array.from(dependencyNames).sort()) {
      const baseKeys = baseRequirements.requirementKeysByName.get(dependency) ?? new Set()
      const headKeys = headRequirements.requirementKeysByName.get(dependency) ?? new Set()

      if (baseKeys.size === 0) {
        newDependencies.push(`${file}: ${dependency}`)
        continue
      }

      if (headKeys.size === 0) {
        errors.push(`${file}:dependency-removed:${dependency}`)
        continue
      }

      if (!setEquals(baseKeys, headKeys)) {
        errors.push(`${file}:requirement-variants-changed:${dependency}`)
      }
    }
  }

  let status = 'clear'
  if (requirementFiles.length === 0) {
    status = 'no-dependency-files'
  } else if (errors.length > 0) {
    status = 'error'
  } else if (newDependencies.length > 0) {
    status = 'new-dependencies'
  }

  return {
    ok: errors.length === 0 && newDependencies.length === 0,
    status,
    changedFiles: requirementFiles,
    skippedFiles,
    newDependencies,
    errors
  }
}
