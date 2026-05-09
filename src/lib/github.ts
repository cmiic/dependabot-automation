const API_VERSION = '2022-11-28'
const USER_AGENT = 'cmiic-dependabot-automation'

export type MergeMethod = 'MERGE' | 'SQUASH' | 'REBASE'

export interface GitHubUser {
  login?: string
}

export interface PullRequestRef {
  sha: string
}

export interface PullRequestSummary {
  number: number
  created_at: string
  user?: GitHubUser | null
  head: PullRequestRef
  base: PullRequestRef
}

export interface PullRequest extends PullRequestSummary {
  node_id: string
  mergeable_state?: string | null
  auto_merge?: Record<string, unknown> | null
}

export interface IssueComment {
  id: number
  body: string
  updated_at: string
  user?: GitHubUser | null
}

interface GraphQLErrorEntry {
  message?: string
}

interface GraphQLResponse<TData> {
  data: TData
  errors?: GraphQLErrorEntry[]
}

interface GitHubClientOptions {
  token?: string
  repository?: string
  serverUrl?: string
  graphqlUrl?: string
}

interface AutoMergeMutationResult {
  enablePullRequestAutoMerge: {
    pullRequest: Pick<PullRequest, 'number'>
  }
}

interface DisableAutoMergeMutationResult {
  disablePullRequestAutoMerge: {
    pullRequest: Pick<PullRequest, 'number'>
  }
}

export function parseCsvList (raw: string | null | undefined): string[] {
  return String(raw ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
}

export function normalizeMergeMethod (raw: string | null | undefined = 'squash'): MergeMethod {
  const normalized = String(raw).trim().toUpperCase()

  if (normalized === 'MERGE' || normalized === 'SQUASH' || normalized === 'REBASE') {
    return normalized
  }

  throw new Error(`Unsupported merge method: ${raw}`)
}

export function calculateAgeDays (createdAt: string, now = Date.now()): number {
  const createdTs = Date.parse(createdAt)
  if (Number.isNaN(createdTs)) {
    throw new Error(`Invalid created_at timestamp: ${createdAt}`)
  }

  return Math.floor((now - createdTs) / 86_400_000)
}

export class GitHubRequestError<TData = unknown> extends Error {
  status: number
  data: TData

  constructor (message: string, status: number, data: TData) {
    super(message)
    this.name = 'GitHubRequestError'
    this.status = status
    this.data = data
  }
}

export class GitHubClient {
  token: string
  serverUrl: string
  graphqlUrl: string
  owner: string
  repo: string

  constructor ({
    token,
    repository = process.env.GITHUB_REPOSITORY,
    serverUrl = process.env.GITHUB_API_URL || 'https://api.github.com',
    graphqlUrl = process.env.GITHUB_GRAPHQL_URL
  }: GitHubClientOptions) {
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

    if (!owner || !repo) {
      throw new Error(`Invalid GITHUB_REPOSITORY value: ${repository}`)
    }

    this.owner = owner
    this.repo = repo
  }

  async request<TResponse> (method: string, path: string, body?: unknown): Promise<TResponse> {
    const response = await fetch(`${this.serverUrl}${path}`, {
      method,
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        'X-GitHub-Api-Version': API_VERSION
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })

    const text = await response.text()
    const data = text ? JSON.parse(text) as TResponse : null as TResponse

    if (!response.ok) {
      throw new GitHubRequestError(`${method} ${path} failed with ${response.status}`, response.status, data)
    }

    return data
  }

  async graphql<TResponse> (query: string, variables: Record<string, unknown>): Promise<TResponse> {
    const response = await fetch(this.graphqlUrl, {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        'X-GitHub-Api-Version': API_VERSION
      },
      body: JSON.stringify({ query, variables })
    })

    const payload = await response.json() as GraphQLResponse<TResponse>

    if (!response.ok || payload.errors?.length) {
      throw new GitHubRequestError('GraphQL request failed', response.status, payload)
    }

    return payload.data
  }

  async enablePullRequestAutoMerge ({ pullRequestId, mergeMethod }: { pullRequestId: string, mergeMethod: MergeMethod }): Promise<Pick<PullRequest, 'number'>> {
    const data = await this.graphql<AutoMergeMutationResult>(
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
        mergeMethod
      }
    )

    return data.enablePullRequestAutoMerge.pullRequest
  }

  async disablePullRequestAutoMerge (pullRequestId: string): Promise<Pick<PullRequest, 'number'>> {
    const data = await this.graphql<DisableAutoMergeMutationResult>(
      `
        mutation DisablePullRequestAutoMerge($pullRequestId: ID!) {
          disablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) {
            pullRequest {
              number
            }
          }
        }
      `,
      {
        pullRequestId
      }
    )

    return data.disablePullRequestAutoMerge.pullRequest
  }

  async mergePullRequest (number: number, mergeMethod: MergeMethod): Promise<unknown> {
    return this.request('PUT', `/repos/${this.owner}/${this.repo}/pulls/${number}/merge`, {
      merge_method: mergeMethod.toLowerCase()
    })
  }

  async listOpenPullRequests (): Promise<PullRequestSummary[]> {
    const items: PullRequestSummary[] = []

    for (let page = 1; ; page += 1) {
      const pageItems = await this.request<PullRequestSummary[]>(
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

  async getPullRequest (number: number): Promise<PullRequest> {
    return this.request<PullRequest>('GET', `/repos/${this.owner}/${this.repo}/pulls/${number}`)
  }

  async listIssueComments (issueNumber: number): Promise<IssueComment[]> {
    const items: IssueComment[] = []

    for (let page = 1; ; page += 1) {
      const pageItems = await this.request<IssueComment[]>(
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

  async createIssueComment (issueNumber: number, body: string): Promise<IssueComment> {
    return this.request<IssueComment>('POST', `/repos/${this.owner}/${this.repo}/issues/${issueNumber}/comments`, {
      body
    })
  }

  async updateIssueComment (commentId: number, body: string): Promise<IssueComment> {
    return this.request<IssueComment>('PATCH', `/repos/${this.owner}/${this.repo}/issues/comments/${commentId}`, {
      body
    })
  }
}
