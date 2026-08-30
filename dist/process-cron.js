// src/entrypoints/process-cron.ts
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

// src/lib/approval-signal.ts
var APPROVAL_MARKER_PREFIX = "<!-- dependabot-automation:approval ";
var APPROVAL_CHECKED_AT_SLACK_MS = 5 * 60 * 1e3;
function getApprovalCheckedAt(payload, comment) {
  if (typeof payload?.checkedAt !== "string") {
    return null;
  }
  const payloadMs = Date.parse(payload.checkedAt);
  if (Number.isNaN(payloadMs)) {
    return null;
  }
  if (typeof comment?.created_at === "string") {
    const createdMs = Date.parse(comment.created_at);
    if (!Number.isNaN(createdMs) && payloadMs < createdMs - APPROVAL_CHECKED_AT_SLACK_MS) {
      return comment.created_at;
    }
  }
  return payload.checkedAt;
}
function parseApprovalComment(body) {
  if (typeof body !== "string" || !body.startsWith(APPROVAL_MARKER_PREFIX)) {
    return null;
  }
  const suffix = " -->";
  const endIndex = body.indexOf(suffix, APPROVAL_MARKER_PREFIX.length);
  if (endIndex === -1) {
    return null;
  }
  try {
    return JSON.parse(body.slice(APPROVAL_MARKER_PREFIX.length, endIndex));
  } catch {
    return null;
  }
}

// src/lib/github.ts
var API_VERSION = "2022-11-28";
var USER_AGENT = "cmiic-dependabot-automation";
function normalizeMergeMethod(raw = "squash") {
  const normalized = String(raw).trim().toUpperCase();
  if (normalized === "MERGE" || normalized === "SQUASH" || normalized === "REBASE") {
    return normalized;
  }
  throw new Error(`Unsupported merge method: ${raw}`);
}
function calculateAgeDays(createdAt, now = Date.now()) {
  const createdTs = Date.parse(createdAt);
  if (Number.isNaN(createdTs)) {
    throw new TypeError(`Invalid created_at timestamp: ${createdAt}`);
  }
  return Math.floor((now - createdTs) / 864e5);
}
var GitHubRequestError = class extends Error {
  status;
  data;
  constructor(message, status, data) {
    super(message);
    this.name = "GitHubRequestError";
    this.status = status;
    this.data = data;
  }
};
var GitHubClient = class {
  token;
  serverUrl;
  graphqlUrl;
  owner;
  repo;
  constructor({
    token: token2,
    repository = process.env.GITHUB_REPOSITORY,
    serverUrl = process.env.GITHUB_API_URL || "https://api.github.com",
    graphqlUrl = process.env.GITHUB_GRAPHQL_URL
  }) {
    if (!token2) {
      throw new Error("Missing GitHub token");
    }
    if (!repository?.includes("/")) {
      throw new Error(`Invalid GITHUB_REPOSITORY value: ${repository}`);
    }
    this.token = token2;
    this.serverUrl = serverUrl.replace(/\/$/, "");
    this.graphqlUrl = (graphqlUrl || `${this.serverUrl}/graphql`).replace(/\/$/, "");
    const [owner, repo] = repository.split("/", 2);
    if (!owner || !repo) {
      throw new Error(`Invalid GITHUB_REPOSITORY value: ${repository}`);
    }
    this.owner = owner;
    this.repo = repo;
  }
  async request(method, path, body) {
    const response = await fetch(`${this.serverUrl}${path}`, {
      method,
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": API_VERSION
      },
      body: body === void 0 ? void 0 : JSON.stringify(body)
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw new GitHubRequestError(`${method} ${path} failed with ${response.status}`, response.status, data);
    }
    return data;
  }
  async graphql(query, variables) {
    const response = await fetch(this.graphqlUrl, {
      method: "POST",
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": API_VERSION
      },
      body: JSON.stringify({ query, variables })
    });
    const payload = await response.json();
    if (!response.ok || payload.errors?.length) {
      throw new GitHubRequestError("GraphQL request failed", response.status, payload);
    }
    return payload.data;
  }
  async enablePullRequestAutoMerge({ pullRequestId, mergeMethod: mergeMethod2 }) {
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
        mergeMethod: mergeMethod2
      }
    );
    return data.enablePullRequestAutoMerge.pullRequest;
  }
  async disablePullRequestAutoMerge(pullRequestId) {
    const data = await this.graphql(
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
    );
    return data.disablePullRequestAutoMerge.pullRequest;
  }
  async mergePullRequest(number, mergeMethod2) {
    return this.request("PUT", `/repos/${this.owner}/${this.repo}/pulls/${number}/merge`, {
      merge_method: mergeMethod2.toLowerCase()
    });
  }
  async listOpenPullRequests() {
    const items = [];
    for (let page = 1; ; page += 1) {
      const pageItems = await this.request(
        "GET",
        `/repos/${this.owner}/${this.repo}/pulls?state=open&per_page=100&page=${page}`
      );
      items.push(...pageItems);
      if (pageItems.length < 100) {
        break;
      }
    }
    return items;
  }
  async getPullRequest(number) {
    return this.request("GET", `/repos/${this.owner}/${this.repo}/pulls/${number}`);
  }
  async listIssueComments(issueNumber) {
    const items = [];
    for (let page = 1; ; page += 1) {
      const pageItems = await this.request(
        "GET",
        `/repos/${this.owner}/${this.repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`
      );
      items.push(...pageItems);
      if (pageItems.length < 100) {
        break;
      }
    }
    return items;
  }
  async createIssueComment(issueNumber, body) {
    return this.request("POST", `/repos/${this.owner}/${this.repo}/issues/${issueNumber}/comments`, {
      body
    });
  }
  async updateIssueComment(commentId, body) {
    return this.request("PATCH", `/repos/${this.owner}/${this.repo}/issues/comments/${commentId}`, {
      body
    });
  }
};

// src/entrypoints/process-cron.ts
function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}
var githubOutputPath = requiredEnv("GITHUB_OUTPUT");
function setOutput(name, value) {
  const delimiter = `EOF_${randomUUID()}`;
  appendFileSync(githubOutputPath, `${name}<<${delimiter}
${String(value)}
${delimiter}
`);
}
function hasApprovalPayload(entry) {
  return entry.payload !== null;
}
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function extractErrorMessages(error) {
  const messages = [];
  if (error instanceof GitHubRequestError && isRecord(error.data)) {
    if (typeof error.data.message === "string") {
      messages.push(error.data.message);
    }
    if (Array.isArray(error.data.errors)) {
      for (const item of error.data.errors) {
        if (isRecord(item) && typeof item.message === "string") {
          messages.push(item.message);
        }
      }
    }
  }
  if (error instanceof Error) {
    messages.push(error.message);
  }
  return messages;
}
function errorMessageMatches(error, pattern) {
  return extractErrorMessages(error).some((message) => pattern.test(message));
}
function isNothingToAutoMergeError(error) {
  return errorMessageMatches(error, /clean status|pull request is in clean|nothing to merge/i);
}
function isAutoMergeAlreadyEnabledError(error) {
  return errorMessageMatches(error, /auto[- ]?merge.*already|already has auto[- ]?merge/i);
}
var token = process.env.GITHUB_TOKEN;
var quarantineDays = Number.parseInt(process.env.QUARANTINE_DAYS ?? "3", 10);
var mergeMethod = normalizeMergeMethod(process.env.MERGE_METHOD);
var github = new GitHubClient({ token });
var pullRequests = await github.listOpenPullRequests();
var dependabotPullRequests = pullRequests.filter((pullRequest) => pullRequest.user?.login === "dependabot[bot]");
console.log(`Found ${dependabotPullRequests.length} open Dependabot PR(s)`);
var processedCount = 0;
var quarantinePassedCount = 0;
var mergedCount = 0;
var automergeEnabledCount = 0;
var alreadyEnabledCount = 0;
var failedCount = 0;
var candidates = [];
for (const pullRequestSummary of dependabotPullRequests) {
  processedCount += 1;
  console.log("\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501");
  console.log(`PR #${pullRequestSummary.number}`);
  console.log(`  Created: ${pullRequestSummary.created_at}`);
  try {
    const pullRequest = await github.getPullRequest(pullRequestSummary.number);
    const comments = await github.listIssueComments(pullRequestSummary.number);
    const approvalComment = comments.filter((comment) => comment.user?.login === "github-actions[bot]").map((comment) => ({ comment, payload: parseApprovalComment(comment.body) })).filter(hasApprovalPayload).sort((left, right) => Date.parse(right.comment.updated_at) - Date.parse(left.comment.updated_at))[0];
    if (!approvalComment) {
      console.log("  Skipping: no machine-written approval signal found");
      continue;
    }
    if (approvalComment.payload.status !== "approved") {
      console.log(`  Skipping: latest approval signal status is ${approvalComment.payload.status}`);
      continue;
    }
    if (approvalComment.payload.sha !== pullRequest.head.sha) {
      console.log(
        `  Skipping: approval signal is for ${approvalComment.payload.sha}, current head is ${pullRequest.head.sha}`
      );
      continue;
    }
    const checkedAt = getApprovalCheckedAt(approvalComment.payload, approvalComment.comment);
    if (!checkedAt) {
      console.log("  Skipping: latest approval signal has no valid checkedAt timestamp");
      continue;
    }
    const ageDays = calculateAgeDays(checkedAt);
    console.log(`  Approved at: ${checkedAt}`);
    console.log(`  Approval age: ${ageDays} day(s)`);
    if (ageDays < quarantineDays) {
      console.log(`  Waiting for quarantine (${ageDays} < ${quarantineDays} days since approval)`);
      continue;
    }
    quarantinePassedCount += 1;
    console.log(`  Quarantine passed (mergeable_state: ${pullRequest.mergeable_state ?? "unknown"})`);
    candidates.push({ pullRequest, checkedAt });
  } catch (error) {
    failedCount += 1;
    console.log(`  Failed: ${getErrorMessage(error)}`);
  }
}
candidates.sort((left, right) => Date.parse(left.checkedAt) - Date.parse(right.checkedAt));
var pipelineBusy = false;
for (const { pullRequest } of candidates) {
  const number = pullRequest.number;
  console.log("\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501");
  console.log(`PR #${number} (acting)`);
  if (pipelineBusy) {
    console.log("  Skipping: older candidate is in flight; will revisit next run");
    continue;
  }
  const state = pullRequest.mergeable_state;
  try {
    if (pullRequest.auto_merge) {
      if (state === "behind") {
        console.log("  Auto-merge enabled but branch behind; disabling so the rebased SHA cannot merge before cron re-validates approval");
        try {
          await github.disablePullRequestAutoMerge(pullRequest.node_id);
        } catch (disableError) {
          console.log(`  Could not disable existing auto-merge: ${getErrorMessage(disableError)}`);
          throw disableError;
        }
        console.log("  Waiting for Dependabot to rebase");
        pipelineBusy = true;
      } else if (state === "dirty") {
        console.log("  Auto-merge enabled but branch has conflicts; needs manual resolution");
      } else {
        alreadyEnabledCount += 1;
        pipelineBusy = true;
        console.log(`  Auto-merge already enabled (state: ${state ?? "null"}); holding pipeline`);
      }
    } else if (state === "clean") {
      try {
        await github.mergePullRequest(number, mergeMethod);
        mergedCount += 1;
        pipelineBusy = true;
        console.log("  Merged");
      } catch (mergeError) {
        if (mergeError instanceof GitHubRequestError && (mergeError.status === 405 || mergeError.status === 409)) {
          const mergeErrorMessage = isRecord(mergeError.data) && typeof mergeError.data.message === "string" ? mergeError.data.message : getErrorMessage(mergeError);
          console.log(`  Direct merge refused (${mergeError.status}): ${mergeErrorMessage}`);
          console.log("  Not actionable from cron; waiting for Dependabot to rebase (queue continues)");
        } else {
          throw mergeError;
        }
      }
    } else if (state === "behind") {
      console.log("  Branch behind base; not actionable from cron, waiting for Dependabot to rebase (queue continues)");
    } else if (state === "blocked" || state === "unstable") {
      await enableAutoMerge(pullRequest, `checks pending (${state})`);
      pipelineBusy = true;
    } else if (state === "dirty") {
      console.log("  Skipping: merge conflict, needs manual resolution");
    } else if (state === "draft") {
      console.log("  Skipping: pull request is a draft");
    } else {
      console.log(`  Skipping: mergeable_state is ${state ?? "null"}; will be retried next run`);
    }
  } catch (error) {
    failedCount += 1;
    pipelineBusy = true;
    console.log(`  Failed: ${getErrorMessage(error)}`);
  }
}
console.log("\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501");
console.log("Done.");
setOutput("processed-count", processedCount);
setOutput("quarantine-passed-count", quarantinePassedCount);
setOutput("merged-count", mergedCount);
setOutput("automerge-enabled-count", automergeEnabledCount);
setOutput("already-enabled-count", alreadyEnabledCount);
setOutput("failed-count", failedCount);
async function enableAutoMerge(pullRequest, reason) {
  console.log(`  Enabling auto-merge (${reason})`);
  try {
    await github.enablePullRequestAutoMerge({
      pullRequestId: pullRequest.node_id,
      mergeMethod
    });
    automergeEnabledCount += 1;
    console.log("  Auto-merge enabled");
  } catch (error) {
    if (isAutoMergeAlreadyEnabledError(error)) {
      alreadyEnabledCount += 1;
      console.log("  Auto-merge already enabled");
      return;
    }
    if (isNothingToAutoMergeError(error)) {
      console.log("  PR is already mergeable; next cron run will merge directly");
      return;
    }
    throw error;
  }
}
