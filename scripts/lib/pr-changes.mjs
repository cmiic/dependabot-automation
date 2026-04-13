import { execFileSync } from 'node:child_process'
import path from 'node:path'

const NPM_AND_YARN_BASENAMES = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
])
const DOCKER_COMPOSE_BASENAMES = new Set([
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
])

function normalizePath(filePath) {
  return filePath.replace(/\\/g, '/')
}

function hasYamlExtension(filePath) {
  return /\.ya?ml$/i.test(filePath)
}

function hasJsonExtension(filePath) {
  return /\.jsonc?$/i.test(filePath)
}

function isDockerfile(filePath) {
  const basename = path.basename(filePath)

  return (
    basename === 'Dockerfile' ||
    basename.startsWith('Dockerfile.') ||
    basename.endsWith('.Dockerfile') ||
    basename === 'Containerfile' ||
    basename.startsWith('Containerfile.') ||
    basename.endsWith('.Containerfile')
  )
}

function isDockerComposeFile(filePath) {
  return DOCKER_COMPOSE_BASENAMES.has(path.basename(filePath))
}

function isNpmAndYarnFile(filePath) {
  return NPM_AND_YARN_BASENAMES.has(path.basename(filePath))
}

function isGitHubActionsFile(filePath) {
  const normalized = normalizePath(filePath)
  const basename = path.basename(normalized)

  if (basename === 'action.yml' || basename === 'action.yaml') {
    return true
  }

  return normalized.startsWith('.github/workflows/') && hasYamlExtension(normalized)
}

function isDevcontainerFile(filePath) {
  const normalized = normalizePath(filePath)
  const basename = path.basename(normalized)
  const inDevcontainerDir =
    normalized.startsWith('.devcontainer/') || normalized.includes('/.devcontainer/')

  if (basename === '.devcontainer.json') {
    return true
  }

  if (basename === 'devcontainer.json') {
    return true
  }

  return inDevcontainerDir && (hasJsonExtension(normalized) || hasYamlExtension(normalized) || isDockerfile(normalized))
}

function isDockerFile(filePath) {
  return isDockerfile(filePath) || isDockerComposeFile(filePath)
}

const ECOSYSTEM_FILE_MATCHERS = new Map([
  ['npm_and_yarn', isNpmAndYarnFile],
  ['github_actions', isGitHubActionsFile],
  ['devcontainers', isDevcontainerFile],
  ['docker', isDockerFile],
])

export function runGit(args, cwd = process.cwd()) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

export function listChangedFiles({ baseSha, headSha, cwd = process.cwd() }) {
  const output = runGit(['diff', '--name-only', baseSha, headSha], cwd)

  return output
    .split('\n')
    .map((line) => normalizePath(line.trim()))
    .filter(Boolean)
}

export function extractActionOwners(dependencyNames) {
  if (!dependencyNames) return new Set()

  return new Set(
    dependencyNames
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => name.split('/')[0])
      .filter(Boolean),
  )
}

export function findUnexpectedFiles({ packageEcosystem, changedFiles }) {
  const matcher = ECOSYSTEM_FILE_MATCHERS.get(packageEcosystem)

  if (!matcher) {
    return [...changedFiles]
  }

  return changedFiles.filter((filePath) => !matcher(filePath))
}
