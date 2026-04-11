import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const LOCKFILE_BASENAMES = new Set(['package-lock.json', 'npm-shrinkwrap.json'])

function runGit(args, cwd = process.cwd()) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function isSupportedLockfile(filePath) {
  return LOCKFILE_BASENAMES.has(path.basename(filePath))
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

function isMissingPathInBase(error) {
  const message = getErrorMessage(error)
  return (
    message.includes(' exists on disk, but not in ') ||
    (message.includes("fatal: path '") && message.includes("' does not exist in '"))
  )
}

export function findChangedLockfiles({ baseSha, headSha, cwd = process.cwd() }) {
  const output = runGit(['diff', '--name-only', baseSha, headSha], cwd)

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(isSupportedLockfile)
}

export function checkChangedLockfiles({ baseSha, headSha, cwd = process.cwd() }) {
  const changedFiles = findChangedLockfiles({ baseSha, headSha, cwd })
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
