import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import toml from 'toml'

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
      const baseLockfile = toml.parse(baseContent)
      const headLockfile = toml.parse(headContent)
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