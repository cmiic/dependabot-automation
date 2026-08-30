import path from 'node:path'

import type { ChangedFileComparison, ChangedFileContents } from './compare-changed-files.ts'
import { compareChangedFiles, getErrorMessage } from './compare-changed-files.ts'
import { compareStrings } from './compare-strings.ts'
import { listChangedFiles } from './pr-changes.ts'

const LOCKFILE_BASENAMES = new Set(['package-lock.json', 'npm-shrinkwrap.json'])
const UNSUPPORTED_LOCKFILE_BASENAMES = new Set(['yarn.lock', 'pnpm-lock.yaml'])

interface LockfilePackages {
  [packagePath: string]: unknown
}

interface NpmLockfile {
  packages: LockfilePackages
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

    const match = /node_modules\/(.+)$/.exec(packagePath)
    const dependencyPath = match?.[1]

    if (!dependencyPath) {
      continue
    }

    dependencies.add(dependencyPath)
  }
}

function hasPackagesObject (lockfile: unknown): lockfile is NpmLockfile {
  return (
    typeof lockfile === 'object'
    && lockfile !== null
    && 'packages' in lockfile
    && typeof lockfile.packages === 'object'
    && lockfile.packages !== null
  )
}

export function extractDependencies (lockfile: unknown): Set<string> {
  if (!hasPackagesObject(lockfile)) {
    throw new Error('unsupported-lockfile-format: expected lockfile.packages object')
  }

  const dependencies = new Set<string>()
  addDependenciesFromPackages(lockfile.packages, dependencies)

  return dependencies
}

export function findChangedLockfiles ({ baseSha, headSha, cwd = process.cwd() }: { baseSha: string, headSha: string, cwd?: string }): { changedFiles: string[], unsupportedFiles: string[] } {
  const changedFiles = listChangedFiles({ baseSha, headSha, cwd })

  return {
    changedFiles: changedFiles.filter(isSupportedLockfile),
    unsupportedFiles: changedFiles.filter(isUnsupportedLockfile)
  }
}

function compareLockfiles ({ file, baseContent, headContent }: ChangedFileContents): ChangedFileComparison {
  const newDependencies: string[] = []

  try {
    const baseLockfile = JSON.parse(baseContent) as NpmLockfile
    const headLockfile = JSON.parse(headContent) as NpmLockfile
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
  const skippedFiles: string[] = []
  const errors = unsupportedFiles.map(file => `${file}:unsupported-lockfile`)

  const comparison = compareChangedFiles({ files: changedFiles, baseSha, cwd, compare: compareLockfiles })
  const { newDependencies } = comparison
  errors.push(...comparison.errors)

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
