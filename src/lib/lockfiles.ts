import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { listChangedFiles, pathExistsInGitRevision, runGit } from './pr-changes.ts'

const LOCKFILE_BASENAMES = new Set(['package-lock.json', 'npm-shrinkwrap.json'])
const UNSUPPORTED_LOCKFILE_BASENAMES = new Set(['yarn.lock', 'pnpm-lock.yaml'])

interface LockfilePackages {
  [packagePath: string]: unknown
}

type NpmLockfile = Record<string, unknown> & {
  packages?: unknown
}

function isSupportedLockfile (filePath: string): boolean {
  return LOCKFILE_BASENAMES.has(path.basename(filePath))
}

function isUnsupportedLockfile (filePath: string): boolean {
  return UNSUPPORTED_LOCKFILE_BASENAMES.has(path.basename(filePath))
}

function addDependenciesFromPackages (packages: LockfilePackages, dependencies: Set<string>): void {
  for (const packagePath of Object.keys(packages)) {
    if (!packagePath) {
      continue
    }

    const match = packagePath.match(/node_modules\/(.+)$/)
    const dependencyPath = match?.[1]

    if (!dependencyPath) {
      continue
    }

    dependencies.add(dependencyPath)
  }
}

export function extractDependencies (lockfile: NpmLockfile): Set<string> {
  if (!lockfile.packages || typeof lockfile.packages !== 'object') {
    throw new Error('unsupported-lockfile-format: expected lockfile.packages object')
  }

  const dependencies = new Set<string>()
  addDependenciesFromPackages(lockfile.packages as LockfilePackages, dependencies)

  return dependencies
}

function getErrorMessage (error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.replace(/\s+/g, ' ').trim()

  if (normalized.length <= 240) {
    return normalized
  }

  return `${normalized.slice(0, 237)}...`
}

export function findChangedLockfiles ({ baseSha, headSha, cwd = process.cwd() }: { baseSha: string, headSha: string, cwd?: string }): { changedFiles: string[], unsupportedFiles: string[] } {
  const changedFiles = listChangedFiles({ baseSha, headSha, cwd })

  return {
    changedFiles: changedFiles.filter(isSupportedLockfile),
    unsupportedFiles: changedFiles.filter(isUnsupportedLockfile)
  }
}

export function checkChangedLockfiles ({ baseSha, headSha, cwd = process.cwd() }: { baseSha: string, headSha: string, cwd?: string }): {
  ok: boolean
  status: string
  changedFiles: string[]
  unsupportedFiles: string[]
  skippedFiles: string[]
  newDependencies: string[]
  errors: string[]
} {
  const { changedFiles, unsupportedFiles } = findChangedLockfiles({ baseSha, headSha, cwd })
  const newDependencies: string[] = []
  const errors: string[] = []
  const skippedFiles: string[] = []

  for (const file of unsupportedFiles) {
    errors.push(`${file}:unsupported-lockfile`)
  }

  for (const file of changedFiles) {
    const fullPath = path.join(cwd, file)

    if (!existsSync(fullPath)) {
      errors.push(`${file}:missing-in-head`)
      continue
    }

    let baseContent: string
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

    let headContent: string
    try {
      headContent = readFileSync(fullPath, 'utf8')
    } catch (error) {
      errors.push(`${file}:read-failed:${getErrorMessage(error)}`)
      continue
    }

    try {
      const baseLockfile = JSON.parse(baseContent) as NpmLockfile
      const headLockfile = JSON.parse(headContent) as NpmLockfile
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
    errors
  }
}
