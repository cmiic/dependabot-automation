import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { listChangedFiles, pathExistsInGitRevision, runGit } from './pr-changes.mjs'

const LOCKFILE_BASENAMES = new Set(['package-lock.json', 'npm-shrinkwrap.json'])
const UNSUPPORTED_LOCKFILE_BASENAMES = new Set(['yarn.lock', 'pnpm-lock.yaml'])

function isSupportedLockfile(filePath) {
  return LOCKFILE_BASENAMES.has(path.basename(filePath))
}

function isUnsupportedLockfile(filePath) {
  return UNSUPPORTED_LOCKFILE_BASENAMES.has(path.basename(filePath))
}

function addDependenciesFromPackages(packages, dependencies) {
  for (const packagePath of Object.keys(packages)) {
    if (!packagePath) {
      continue
    }

    const match = packagePath.match(/node_modules\/(.+)$/)
    if (!match) {
      continue
    }

    dependencies.add(match[1])
  }
}

export function extractDependencies(lockfile) {
  if (!lockfile?.packages || typeof lockfile.packages !== 'object') {
    throw new Error('unsupported-lockfile-format: expected lockfile.packages object')
  }

  const dependencies = new Set()
  addDependenciesFromPackages(lockfile.packages, dependencies)

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

export function findChangedLockfiles({ baseSha, headSha, cwd = process.cwd() }) {
  const changedFiles = listChangedFiles({ baseSha, headSha, cwd })

  return {
    changedFiles: changedFiles.filter(isSupportedLockfile),
    unsupportedFiles: changedFiles.filter(isUnsupportedLockfile),
  }
}

export function checkChangedLockfiles({ baseSha, headSha, cwd = process.cwd() }) {
  const { changedFiles, unsupportedFiles } = findChangedLockfiles({ baseSha, headSha, cwd })
  const newDependencies = []
  const errors = []
  const skippedFiles = []

  for (const file of unsupportedFiles) {
    errors.push(`${file}:unsupported-lockfile`)
  }

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

    try {
      const baseLockfile = JSON.parse(baseContent)
      const headLockfile = JSON.parse(headContent)
      const baseDependencies = extractDependencies(baseLockfile)
      const headDependencies = extractDependencies(headLockfile)

      for (const dependency of Array.from(headDependencies).sort()) {
        if (!baseDependencies.has(dependency)) {
          newDependencies.push(`${file}: ${dependency}`)
        }
      }
    } catch (error) {
      errors.push(`${file}:parse-failed:${error.message}`)
    }
  }

  let status = 'clear'
  if (unsupportedFiles.length > 0) {
    status = 'unsupported-lockfile'
  } else if (changedFiles.length === 0) {
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
    unsupportedFiles,
    skippedFiles,
    newDependencies,
    errors,
  }
}
