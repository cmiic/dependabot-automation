const API_VERSION = '2022-11-28'
const USER_AGENT = 'cmiic-dependabot-automation'
export function parseCsvList(raw) {
  return String(raw ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}

export function normalizeMergeMethod(raw = 'merge') {
  const normalized = String(raw).trim().toUpperCase()

  if (normalized === 'MERGE' || normalized === 'SQUASH' || normalized === 'REBASE') {
    return normalized
  }

  throw new Error(`Unsupported merge method: ${raw}`)
}

export function calculateAgeDays(createdAt, now = Date.now()) {
  const createdTs = Date.parse(createdAt)
  if (Number.isNaN(createdTs)) {
    throw new Error(`Invalid created_at timestamp: ${createdAt}`)
  }

  return Math.floor((now - createdTs) / 86_400_000)
}

export class GitHubRequestError extends Error {
  constructor(message, status, data) {
    super(message)
    this.name = 'GitHubRequestError'
    this.status = status
    this.data = data
  }
}

export class GitHubClient {
  constructor({
    token,
    repository = process.env.GITHUB_REPOSITORY,
    serverUrl = process.env.GITHUB_API_URL || 'https://api.github.com',
    graphqlUrl = process.env.GITHUB_GRAPHQL_URL,
  }) {
    if (!token) {
      throw new Error('Missing GitHub token')
    }

    if (!repository || !repository.includes('/')) {
      throw new Error(`Invalid GITHUB_REPOSITORY value: ${repository}`)
    }

    this.token = token
    this.serverUrl = serverUrl.replace(/\/$/, '')
    this.graphqlUrl = (graphqlUrl || `${this.serverUrl}/graphql`).replace(/\/$/, '')
    const [owner, repo] = repository.split('/', 2)
    this.owner = owner
    this.repo = repo
  }

  async request(method, path, body) {
    const response = await fetch(`${this.serverUrl}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        'X-GitHub-Api-Version': API_VERSION,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

    const text = await response.text()
    const data = text ? JSON.parse(text) : null

    if (!response.ok) {
      throw new GitHubRequestError(`${method} ${path} failed with ${response.status}`, response.status, data)
    }

    return data
  }

  async graphql(query, variables) {
    const response = await fetch(this.graphqlUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        'X-GitHub-Api-Version': API_VERSION,
      },
      body: JSON.stringify({ query, variables }),
    })

    const payload = await response.json()

    if (!response.ok || payload.errors?.length) {
      throw new GitHubRequestError('GraphQL request failed', response.status, payload)
    }

    return payload.data
  }

  async enablePullRequestAutoMerge({ pullRequestId, mergeMethod }) {
    const data = await this.graphql(
      `
        mutation EnablePullRequestAutoMerge($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
          enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: $mergeMethod }) {
            pullRequest {
              number
            }
          }
        }
      `,
      {
        pullRequestId,
        mergeMethod,
      }
    )

    return data.enablePullRequestAutoMerge.pullRequest
  }

  async mergePullRequest(number, mergeMethod) {
    return this.request('PUT', `/repos/${this.owner}/${this.repo}/pulls/${number}/merge`, {
      merge_method: mergeMethod.toLowerCase(),
    })
  }

  async listOpenPullRequests() {
    const items = []

    for (let page = 1; ; page += 1) {
      const pageItems = await this.request(
        'GET',
        `/repos/${this.owner}/${this.repo}/pulls?state=open&per_page=100&page=${page}`
      )

      items.push(...pageItems)

      if (pageItems.length < 100) {
        break
      }
    }

    return items
  }

  async getPullRequest(number) {
    return this.request('GET', `/repos/${this.owner}/${this.repo}/pulls/${number}`)
  }

  async listIssueComments(issueNumber) {
    const items = []

    for (let page = 1; ; page += 1) {
      const pageItems = await this.request(
        'GET',
        `/repos/${this.owner}/${this.repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`
      )

      items.push(...pageItems)

      if (pageItems.length < 100) {
        break
      }
    }

    return items
  }

  async createIssueComment(issueNumber, body) {
    return this.request('POST', `/repos/${this.owner}/${this.repo}/issues/${issueNumber}/comments`, {
      body,
    })
  }

  async updateIssueComment(commentId, body) {
    return this.request('PATCH', `/repos/${this.owner}/${this.repo}/issues/comments/${commentId}`, {
      body,
    })
  }
}
