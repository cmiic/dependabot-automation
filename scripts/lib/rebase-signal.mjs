const REBASE_MARKER_PREFIX = '<!-- dependabot-automation:rebase-request '

export function buildRebaseComment(sha) {
  const payload = JSON.stringify({ sha })
  return ['@dependabot rebase', '', `${REBASE_MARKER_PREFIX}${payload} -->`].join('\n')
}

export function parseRebaseComment(body) {
  if (typeof body !== 'string') {
    return null
  }

  const startIndex = body.indexOf(REBASE_MARKER_PREFIX)
  if (startIndex === -1) {
    return null
  }

  const payloadStart = startIndex + REBASE_MARKER_PREFIX.length
  const endIndex = body.indexOf(' -->', payloadStart)
  if (endIndex === -1) {
    return null
  }

  try {
    return JSON.parse(body.slice(payloadStart, endIndex))
  } catch {
    return null
  }
}
