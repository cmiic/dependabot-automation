import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import toml from 'toml'

import { listChangedFiles, pathExistsInGitRevision, runGit } from './pr-changes.ts'

const UV_LOCKFILE_BASENAME = 'uv.lock'

interface UvPackage {
  name: string
}

type UvLockfile = Record<string, unknown> & {
  package?: unknown
}

function isUvLockfile (filePath: string): boolean {
  return path.basename(filePath) === UV_LOCKFILE_BASENAME
}

function addDependenciesFromPackages (packages: UvPackage[], dependencies: Set<string>): void {
  for (const pkg of packages) {
    if (!pkg || typeof pkg !== 'object' || typeof pkg.name !== 'string' || pkg.name.trim() === '') {
      throw new Error('unsupported-lockfile-format: expected each package entry to have a name')
    }

    dependencies.add(pkg.name)
  }
}

function parseUvLock (content: string): Record<string, unknown> {
  return toml.parse(content) as Record<string, unknown>
}

export function extractDependencies (lockfile: UvLockfile): Set<string> {
  if (!Array.isArray(lockfile.package)) {
    throw new Error('unsupported-lockfile-format: expected lockfile.package array')
  }

  const dependencies = new Set<string>()
  addDependenciesFromPackages(lockfile.package as UvPackage[], dependencies)

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

export function findChangedUvLockfiles ({ baseSha, headSha, changedFiles, cwd = process.cwd() }: { baseSha: string, headSha: string, changedFiles?: string[], cwd?: string }): { changedFiles: string[] } {
  const allChangedFiles = changedFiles ?? listChangedFiles({ baseSha, headSha, cwd })

  return {
    changedFiles: allChangedFiles.filter(isUvLockfile)
  }
}

export function checkChangedUvLockfiles ({ baseSha, headSha, cwd = process.cwd() }: { baseSha: string, headSha: string, cwd?: string }): {
  ok: boolean
  status: string
  changedFiles: string[]
  skippedFiles: string[]
  newDependencies: string[]
  errors: string[]
} {
  const { changedFiles } = findChangedUvLockfiles({ baseSha, headSha, cwd })
  const newDependencies: string[] = []
  const errors: string[] = []
  const skippedFiles: string[] = []

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
    errors
  }
}
