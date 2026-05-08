import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { listChangedFiles, pathExistsInGitRevision, runGit } from './pr-changes.mjs'

const UV_LOCKFILE_BASENAME = 'uv.lock'

function isUvLockfile(filePath) {
  return path.basename(filePath) === UV_LOCKFILE_BASENAME
}

function addDependenciesFromPackages(packages, dependencies) {
  for (const pkg of packages) {
    if (!pkg || typeof pkg !== 'object' || typeof pkg.name !== 'string' || pkg.name.trim() === '') {
      throw new Error('unsupported-lockfile-format: expected each package entry to have a name')
    }

    dependencies.add(pkg.name)
  }
}

function parseQuotedTomlString(value) {
  const trimmed = value.trim()

  if (/^"(?:[^"\\]|\\.)*"$/.test(trimmed)) {
    try {
      return JSON.parse(trimmed)
    } catch {
      throw new Error('unsupported-lockfile-format: invalid quoted string')
    }
  }

  if (/^'[^'\n]*'$/.test(trimmed)) {
    return trimmed.slice(1, -1)
  }

  throw new Error('unsupported-lockfile-format: expected quoted string')
}

function findPackageNameInSection(section, packageIndex) {
  const lines = section.split('\n')

  for (const line of lines) {
    const trimmed = line.trim()

    if (!trimmed) {
      continue
    }

    if (trimmed.startsWith('[')) {
      break
    }

    const nameMatch = trimmed.match(/^name\s*=\s*("(?:[^"\\]|\\.)*"|'[^'\n]*')\s*(?:#.*)?$/)
    if (!nameMatch) {
      continue
    }

    const name = parseQuotedTomlString(nameMatch[1]).trim()
    if (!name) {
      throw new Error(`unsupported-lockfile-format: expected package name in [[package]] entry ${packageIndex}`)
    }

    return name
  }

  throw new Error(`unsupported-lockfile-format: expected package name in [[package]] entry ${packageIndex}`)
}

function parseUvLock(content) {
  const lines = content.split('\n')

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim()

    if (!trimmed.startsWith('[')) {
      continue
    }

    if (/^\[\[[A-Za-z0-9_.-]+\]\]\s*(?:#.*)?$/.test(trimmed) || /^\[[A-Za-z0-9_.-]+\]\s*(?:#.*)?$/.test(trimmed)) {
      continue
    }

    throw new Error(`unsupported-lockfile-format: malformed table header at line ${index + 1}`)
  }

  const packageHeaderPattern = /^\s*\[\[package\]\]\s*(?:#.*)?$/gm
  const packageHeaderMatches = Array.from(content.matchAll(packageHeaderPattern))

  if (packageHeaderMatches.length === 0) {
    throw new Error('unsupported-lockfile-format: expected at least one [[package]] entry')
  }

  const packages = []

  for (const [index, match] of packageHeaderMatches.entries()) {
    const sectionStart = match.index + match[0].length
    const sectionEnd = packageHeaderMatches[index + 1]?.index ?? content.length
    const section = content.slice(sectionStart, sectionEnd)

    packages.push({
      name: findPackageNameInSection(section, index + 1),
    })
  }

  return { package: packages }
}

export function extractDependencies(lockfile) {
  if (!Array.isArray(lockfile?.package)) {
    throw new Error('unsupported-lockfile-format: expected lockfile.package array')
  }

  const dependencies = new Set()
  addDependenciesFromPackages(lockfile.package, dependencies)

  return dependencies
}

function getErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.replace(/\s+/g, ' ').trim()

  if (normalized.length <= 240) {
    return normalized
  }

  return `${normalized.slice(0, 237)}...`
}

export function findChangedUvLockfiles({ baseSha, headSha, changedFiles, cwd = process.cwd() }) {
  const allChangedFiles = changedFiles ?? listChangedFiles({ baseSha, headSha, cwd })

  return {
    changedFiles: allChangedFiles.filter(isUvLockfile),
  }
}

export function checkChangedUvLockfiles({ baseSha, headSha, cwd = process.cwd() }) {
  const { changedFiles } = findChangedUvLockfiles({ baseSha, headSha, cwd })
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

    try {
      const baseLockfile = parseUvLock(baseContent)
      const headLockfile = parseUvLock(headContent)
      const baseDependencies = extractDependencies(baseLockfile)
      const headDependencies = extractDependencies(headLockfile)

      for (const dependency of Array.from(headDependencies).sort()) {
        if (!baseDependencies.has(dependency)) {
          newDependencies.push(`${file}: ${dependency}`)
        }
      }
    } catch (error) {
      errors.push(`${file}:parse-failed:${getErrorMessage(error)}`)
    }
  }

  let status = 'clear'
  if (changedFiles.length === 0) {
    status = 'no-lockfiles'
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