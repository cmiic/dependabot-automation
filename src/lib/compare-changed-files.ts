import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { pathExistsInGitRevision, runGit } from './pr-changes.ts'

const MAX_ERROR_MESSAGE_LENGTH = 240
const TRUNCATION_SUFFIX = '...'

export interface ChangedFileContents {
  file: string
  baseContent: string
  headContent: string
}

export interface ChangedFileComparison {
  newDependencies: string[]
  errors: string[]
}

type CompareContents = (contents: ChangedFileContents) => ChangedFileComparison

export function getErrorMessage (error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.replace(/\s+/g, ' ').trim()

  if (normalized.length <= MAX_ERROR_MESSAGE_LENGTH) {
    return normalized
  }

  return `${normalized.slice(0, MAX_ERROR_MESSAGE_LENGTH - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}`
}

// Reading one dependency file at both revisions is identical for every
// ecosystem, down to the error strings: only the comparison of the two
// contents differs. Returning either the contents or the single error that
// explains why they are unavailable keeps that shared shape in one place.
function readChangedFile ({ file, baseSha, cwd }: { file: string, baseSha: string, cwd: string }): ChangedFileContents | { error: string } {
  const fullPath = path.join(cwd, file)

  if (!existsSync(fullPath)) {
    return { error: `${file}:missing-in-head` }
  }

  let baseContent: string
  try {
    baseContent = runGit(['show', `${baseSha}:${file}`], cwd)
  } catch (error) {
    // A file added by the pull request is a different situation from a git
    // failure, and only the second one is worth reporting verbatim.
    if (!pathExistsInGitRevision({ revision: baseSha, filePath: file, cwd })) {
      return { error: `${file}:missing-in-base` }
    }

    return { error: `${file}:git-show-failed:${getErrorMessage(error)}` }
  }

  let headContent: string
  try {
    headContent = readFileSync(fullPath, 'utf8')
  } catch (error) {
    return { error: `${file}:read-failed:${getErrorMessage(error)}` }
  }

  return { file, baseContent, headContent }
}

export function compareChangedFiles ({ files, baseSha, cwd, compare }: { files: string[], baseSha: string, cwd: string, compare: CompareContents }): ChangedFileComparison {
  const newDependencies: string[] = []
  const errors: string[] = []

  for (const file of files) {
    const contents = readChangedFile({ file, baseSha, cwd })

    if ('error' in contents) {
      errors.push(contents.error)
      continue
    }

    const comparison = compare(contents)
    newDependencies.push(...comparison.newDependencies)
    errors.push(...comparison.errors)
  }

  return { newDependencies, errors }
}
