import { execFileSync } from 'node:child_process'
import path from 'node:path'

const NPM_AND_YARN_BASENAMES = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml'
])
const DOCKER_COMPOSE_BASENAMES = new Set([
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml'
])

type FileMatcher = (filePath: string) => boolean

function normalizePath (filePath: string): string {
  return filePath.replaceAll('\\', '/')
}

function hasYamlExtension (filePath: string): boolean {
  return /\.ya?ml$/i.test(filePath)
}

function hasJsonExtension (filePath: string): boolean {
  return /\.jsonc?$/i.test(filePath)
}

function isDockerfile (filePath: string): boolean {
  const basename = path.basename(filePath)

  return (
    basename === 'Dockerfile'
    || basename.startsWith('Dockerfile.')
    || basename.endsWith('.Dockerfile')
    || basename === 'Containerfile'
    || basename.startsWith('Containerfile.')
    || basename.endsWith('.Containerfile')
  )
}

function isDockerComposeFile (filePath: string): boolean {
  return DOCKER_COMPOSE_BASENAMES.has(path.basename(filePath))
}

function isNpmAndYarnFile (filePath: string): boolean {
  return NPM_AND_YARN_BASENAMES.has(path.basename(filePath))
}

function isUvFile (filePath: string): boolean {
  const basename = path.basename(normalizePath(filePath))

  return basename === 'pyproject.toml' || basename === 'uv.lock'
}

export function isPipRequirementsFile (filePath: string): boolean {
  const normalized = normalizePath(filePath)
  const basename = path.basename(normalized).toLowerCase()

  if (!/\.(txt|in)$/i.test(basename)) {
    return false
  }

  if (normalized.startsWith('requirements/') || normalized.includes('/requirements/')) {
    return true
  }

  return (
    /^requirements.*\.(txt|in)$/i.test(basename)
    || /^.+-requirements\.(txt|in)$/i.test(basename)
    || /^constraints.*\.(txt|in)$/i.test(basename)
    || /^.+-constraints\.(txt|in)$/i.test(basename)
  )
}

function isGitHubActionsFile (filePath: string): boolean {
  const normalized = normalizePath(filePath)
  const basename = path.basename(normalized)

  if (basename === 'action.yml' || basename === 'action.yaml') {
    return true
  }

  return normalized.startsWith('.github/workflows/') && hasYamlExtension(normalized)
}

function isDevcontainerFile (filePath: string): boolean {
  const normalized = normalizePath(filePath)
  const basename = path.basename(normalized)
  const inDevcontainerDir
    = normalized.startsWith('.devcontainer/') || normalized.includes('/.devcontainer/')

  if (basename === '.devcontainer.json') {
    return true
  }

  if (basename === 'devcontainer.json') {
    return true
  }

  return inDevcontainerDir && (hasJsonExtension(normalized) || hasYamlExtension(normalized) || isDockerfile(normalized))
}

function isDockerFile (filePath: string): boolean {
  return isDockerfile(filePath) || isDockerComposeFile(filePath)
}

const ECOSYSTEM_FILE_MATCHERS = new Map<string, FileMatcher>([
  ['npm_and_yarn', isNpmAndYarnFile],
  ['uv', isUvFile],
  ['pip', isPipRequirementsFile],
  ['github_actions', isGitHubActionsFile],
  ['devcontainers', isDevcontainerFile],
  ['docker', isDockerFile]
])

export function runGit (args: string[], cwd = process.cwd()): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

export function pathExistsInGitRevision ({ revision, filePath, cwd = process.cwd() }: { revision: string, filePath: string, cwd?: string }): boolean {
  const output = runGit(['ls-tree', '-r', '--name-only', revision, '--', filePath], cwd)

  return output
    .split('\n')
    .map(line => normalizePath(line.trim()))
    .includes(normalizePath(filePath))
}

export function listChangedFiles ({ baseSha, headSha, cwd = process.cwd() }: { baseSha: string, headSha: string, cwd?: string }): string[] {
  const output = runGit(['diff', '--name-only', baseSha, headSha], cwd)

  return output
    .split('\n')
    .map(line => normalizePath(line.trim()))
    .filter(Boolean)
}

export function extractActionOwners (dependencyNames: string | null | undefined): Set<string> {
  if (!dependencyNames) {
    return new Set()
  }

  return new Set(
    dependencyNames
      .split(',')
      .map(name => name.trim())
      .filter(Boolean)
      .map(name => name.split('/')[0])
      .filter(Boolean)
  )
}

export function findUnexpectedFiles ({ packageEcosystem, changedFiles }: { packageEcosystem: string, changedFiles: string[] }): string[] {
  const matcher = ECOSYSTEM_FILE_MATCHERS.get(packageEcosystem)

  if (!matcher) {
    return [...changedFiles]
  }

  return changedFiles.filter(filePath => !matcher(filePath))
}
