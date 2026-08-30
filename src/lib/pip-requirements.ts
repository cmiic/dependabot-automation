import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import type { ChangedFileComparison, ChangedFileContents } from './compare-changed-files.ts'
import { compareChangedFiles } from './compare-changed-files.ts'
import { isPipRequirementsFile, listChangedFiles, pathExistsInGitRevision, runGit } from './pr-changes.ts'

const SIMPLE_REQUIREMENT_PATTERN
  = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\s*\[[A-Za-z0-9._,\-\s]+\])?\s*(===|==|~=|!=|<=|>=|<|>)\s*([^,;\s\\]+)\s*(?:;\s*(.+))?$/

type ComplexReason
  = | 'line-continuation'
    | 'editable'
    | 'include'
    | 'option'
    | 'url'
    | 'path'
    | 'direct-reference'
    | 'range'
    | 'bare-specifier'
    | 'unparseable'

interface IgnoredRequirementLine {
  type: 'ignored'
}

interface ComplexRequirementLine {
  type: 'complex'
  content: string
  lineNumber: number
  reason: ComplexReason
}

interface SimpleRequirementLine {
  type: 'requirement'
  name: string
  operator: string
  version: string
  extras: string
  marker: string
  key: string
  lineNumber: number
}

type ParsedRequirementLine = IgnoredRequirementLine | ComplexRequirementLine | SimpleRequirementLine

interface ExtractedRequirements {
  dependencies: Set<string>
  requirementKeysByName: Map<string, Set<string>>
  complexLines: ComplexRequirementLine[]
}

interface ComplexLineMapEntry {
  count: number
  line: ComplexRequirementLine
}

export interface ChangedPipFileClassification {
  requirementFiles: string[]
  unexpectedFiles: string[]
}

function normalizePackageName (name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-')
}

function normalizeExtras (extras?: string): string {
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

function normalizeMarker (marker?: string): string {
  return marker ? marker.replace(/\s+/g, ' ').trim() : ''
}

function normalizePath (filePath: string): string {
  return filePath.replaceAll('\\', '/')
}

function isNamedPipRequirementsFile (filePath: string): boolean {
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

function isAmbiguousRequirementsDirectoryFile (filePath: string): boolean {
  const normalized = normalizePath(filePath)
  const basename = path.basename(normalized).toLowerCase()

  return (
    /\.(txt|in)$/i.test(basename)
    && (normalized.startsWith('requirements/') || normalized.includes('/requirements/'))
    && !isNamedPipRequirementsFile(filePath)
  )
}

function stripInlineComment (line: string): string {
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '#' && (index === 0 || /\s/.test(line[index - 1] ?? ''))) {
      return line.slice(0, index).trimEnd()
    }
  }

  return line
}

function complexLine (content: string, lineNumber: number, reason: ComplexReason): ComplexRequirementLine {
  return {
    type: 'complex',
    content: content.replace(/\s+/g, ' ').trim(),
    lineNumber,
    reason
  }
}

export function parseRequirementLine (line: string, lineNumber = 1): ParsedRequirementLine {
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

  const match = SIMPLE_REQUIREMENT_PATTERN.exec(content)
  if (!match && content.includes(',')) {
    return complexLine(content, lineNumber, 'range')
  }

  if (!match && /^[A-Za-z0-9][A-Za-z0-9._-]*(\s*\[[A-Za-z0-9._,\-\s]+\])?\s*(?:;\s*.+)?$/.test(content)) {
    return complexLine(content, lineNumber, 'bare-specifier')
  }

  if (!match) {
    return complexLine(content, lineNumber, 'unparseable')
  }

  const rawName = match[1] as string
  const rawExtras = match[2]
  const operator = match[3] as string
  const version = match[4] as string
  const rawMarker = match[5]
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

export function extractRequirements (content: string): ExtractedRequirements {
  const dependencies = new Set<string>()
  const requirementKeysByName = new Map<string, Set<string>>()
  const complexLines: ComplexRequirementLine[] = []

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

    const keys = requirementKeysByName.get(parsed.name) ?? new Set<string>()
    keys.add(parsed.key)
    requirementKeysByName.set(parsed.name, keys)
  })

  return {
    dependencies,
    requirementKeysByName,
    complexLines
  }
}

function setEquals (left: Set<string>, right: Set<string>): boolean {
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

function buildComplexLineMap (lines: ComplexRequirementLine[]): Map<string, ComplexLineMapEntry> {
  const complexLineMap = new Map<string, ComplexLineMapEntry>()

  for (const line of lines) {
    const key = `${line.reason}|${line.content}`
    const entry = complexLineMap.get(key) ?? { count: 0, line }
    entry.count += 1
    complexLineMap.set(key, entry)
  }

  return complexLineMap
}

function findComplexRequirementLineErrors ({ file, baseRequirements, headRequirements }: { file: string, baseRequirements: ExtractedRequirements, headRequirements: ExtractedRequirements }): string[] {
  const errors: string[] = []
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

    const descriptor = headEntry?.line ?? baseEntry?.line
    if (!descriptor) {
      continue
    }

    for (let index = 0; index < Math.max(baseCount - headCount, 0); index += 1) {
      errors.push(`${file}:unsupported-requirement-removed:${descriptor.content}`)
    }

    for (let index = 0; index < Math.max(headCount - baseCount, 0); index += 1) {
      errors.push(`${file}:unsupported-requirement-added:${descriptor.content}`)
    }
  }

  return errors
}

function isRecognizedRequirementsContent (content: string): boolean {
  return content
    .split('\n')
    .map((line, index) => parseRequirementLine(line, index + 1))
    .every(parsed => parsed.type !== 'complex' || parsed.reason !== 'unparseable')
}

function loadAvailableChangedFileContents ({ baseSha, file, cwd }: { baseSha: string, file: string, cwd: string }): string[] | null {
  const contents: string[] = []

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

export function classifyChangedPipFiles ({ baseSha, headSha, changedFiles, cwd = process.cwd() }: { baseSha: string, headSha: string, changedFiles?: string[], cwd?: string }): ChangedPipFileClassification {
  const allChangedFiles = changedFiles ?? listChangedFiles({ baseSha, headSha, cwd })
  const requirementFiles: string[] = []
  const unexpectedFiles: string[] = []

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

export function findChangedPipRequirementFiles ({ baseSha, headSha, changedFiles, cwd = process.cwd() }: { baseSha: string, headSha: string, changedFiles?: string[], cwd?: string }): { changedFiles: string[] } {
  const allChangedFiles = changedFiles ?? listChangedFiles({ baseSha, headSha, cwd })

  return {
    changedFiles: allChangedFiles.filter(isPipRequirementsFile)
  }
}

function comparePipRequirements ({ file, baseContent, headContent }: ChangedFileContents): ChangedFileComparison {
  const newDependencies: string[] = []
  const baseRequirements = extractRequirements(baseContent)
  const headRequirements = extractRequirements(headContent)
  const errors = findComplexRequirementLineErrors({ file, baseRequirements, headRequirements })

  const dependencyNames = new Set([
    ...baseRequirements.dependencies,
    ...headRequirements.dependencies
  ])

  for (const dependency of Array.from(dependencyNames).sort()) {
    const baseKeys = baseRequirements.requirementKeysByName.get(dependency) ?? new Set<string>()
    const headKeys = headRequirements.requirementKeysByName.get(dependency) ?? new Set<string>()

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

  return { newDependencies, errors }
}

export function checkChangedPipRequirements ({ baseSha, headSha, changedFiles, cwd = process.cwd() }: { baseSha: string, headSha: string, changedFiles?: string[], cwd?: string }): {
  ok: boolean
  status: string
  changedFiles: string[]
  skippedFiles: string[]
  newDependencies: string[]
  errors: string[]
} {
  const { changedFiles: requirementFiles } = findChangedPipRequirementFiles({ baseSha, headSha, changedFiles, cwd })
  const skippedFiles: string[] = []

  const { newDependencies, errors } = compareChangedFiles({ files: requirementFiles, baseSha, cwd, compare: comparePipRequirements })

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
