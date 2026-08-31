import path from 'node:path'

import toml from 'toml'

import type { ChangedFileComparison, ChangedFileContents } from './compare-changed-files.ts'
import { compareChangedFiles, getErrorMessage } from './compare-changed-files.ts'
import { compareStrings } from './compare-strings.ts'
import { listChangedFiles } from './pr-changes.ts'

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
    throw new TypeError('unsupported-lockfile-format: expected lockfile.package array')
  }

  const dependencies = new Set<string>()
  addDependenciesFromPackages(lockfile.package as UvPackage[], dependencies)

  return dependencies
}

export function findChangedUvLockfiles ({ baseSha, headSha, changedFiles, cwd = process.cwd() }: { baseSha: string, headSha: string, changedFiles?: string[], cwd?: string }): { changedFiles: string[] } {
  const allChangedFiles = changedFiles ?? listChangedFiles({ baseSha, headSha, cwd })

  return {
    changedFiles: allChangedFiles.filter(isUvLockfile)
  }
}

function compareUvLockfiles ({ file, baseContent, headContent }: ChangedFileContents): ChangedFileComparison {
  const newDependencies: string[] = []

  try {
    const baseLockfile = parseUvLock(baseContent)
    const headLockfile = parseUvLock(headContent)
    const baseDependencies = extractDependencies(baseLockfile)
    const headDependencies = extractDependencies(headLockfile)

    for (const dependency of Array.from(headDependencies).sort(compareStrings)) {
      if (!baseDependencies.has(dependency)) {
        newDependencies.push(`${file}: ${dependency}`)
      }
    }
  } catch (error) {
    return { newDependencies: [], errors: [`${file}:parse-failed:${getErrorMessage(error)}`] }
  }

  return { newDependencies, errors: [] }
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
  const skippedFiles: string[] = []

  const { newDependencies, errors } = compareChangedFiles({ files: changedFiles, baseSha, cwd, compare: compareUvLockfiles })

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
