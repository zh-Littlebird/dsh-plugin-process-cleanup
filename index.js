/**
 * dsh-plugin-process-cleanup — Host half.
 *
 * The switch is per Session: each Session starts from the global default
 * (`defaultEnabled`, off unless the user changes it) and can be turned on or
 * off on its own from the composer. Turning it on in one Session never affects
 * another.
 *
 * While a Session's switch is on, the plugin contributes the standing cleanup
 * policy to the system prompt and drops a short reminder after write-capable
 * tool calls. The model is expected to clean up BEFORE its final answer, in the
 * same turn: the final answer therefore stays the last assistant message of the
 * turn, and the Chat never folds it into the process section. The plugin never
 * touches the filesystem itself: deletion/moving runs through the session's
 * normal shell tool, so sandbox policy, approvals, and the audit trail still
 * apply.
 */

import { randomUUID } from 'node:crypto'
import Schema from '@deepseek-ai/schemastery'
import {
  WRITE_TOOLS,
  buildPolicy,
  buildReminder,
  isMutationTool,
} from './policy.js'

export const name = 'process-cleanup'

/** The prompt registry is the only hard dependency; everything else is optional. */
export const inject = ['systemPrompt']

export const Config = Schema.object({
  defaultEnabled: Schema.boolean()
    .default(false)
    .volatile()
    .description('新打开的会话是否默认开启收尾清理；已打开的会话不受影响，请在输入框左侧单独开关。'),
  mode: Schema.union([Schema.const('trash'), Schema.const('delete')])
    .default('trash')
    .volatile()
    .description('清理方式：trash=移动到工作区内 .dsh-trash 回收目录；delete=直接删除。'),
  skipSubagents: Schema.boolean()
    .default(true)
    .description('子代理会话不单独提示清理，由父会话统一处理。'),
})

/** Read a config value that may be a volatile reference or a plain value. */
function readRef(reference, fallback) {
  if (reference !== null && typeof reference === 'object' && typeof reference.get === 'function') {
    const value = reference.get()
    return value === undefined ? fallback : value
  }
  return reference === undefined ? fallback : reference
}

/** Cordis refuses to read a service the plugin did not inject. */
function optionalService(ctx, name) {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MAX_TRACKED_SESSIONS = 512

export function apply(ctx, config) {
  /** Per-Session switch; absent means "use the global default at first use". */
  const sessionEnabled = new Map()
  /** Current turn number per Session, learned from `turn/start`. */
  const currentTurn = new Map()
  /** Shell/child reminder already delivered for a turn (write/edit reminders are per call). */
  const remindedTurn = new Map()

  const defaultEnabled = () => readRef(config?.defaultEnabled, false) === true
  const mode = () => (readRef(config?.mode, 'trash') === 'delete' ? 'delete' : 'trash')
  const skipSubagents = () => readRef(config?.skipSubagents, true) !== false

  const enabledFor = (sessionId) => {
    const key = String(sessionId)
    const stored = sessionEnabled.get(key)
    if (stored !== undefined) return stored === true
    const initial = defaultEnabled()
    sessionEnabled.set(key, initial)
    return initial
  }

  const setEnabled = (sessionId, value) => {
    if (sessionEnabled.size >= MAX_TRACKED_SESSIONS && !sessionEnabled.has(String(sessionId))) {
      const oldest = sessionEnabled.keys().next().value
      if (oldest !== undefined) sessionEnabled.delete(oldest)
    }
    sessionEnabled.set(String(sessionId), value === true)
  }

  // Session lifecycle owns the switch: a fresh Session starts from the global
  // default, and closing it forgets the temporary override.
  ctx.on('agent/created', ({ agent }) => {
    try {
      if (!sessionEnabled.has(agent.id)) sessionEnabled.set(agent.id, defaultEnabled())
      currentTurn.delete(agent.id)
      remindedTurn.delete(agent.id)
    } catch {
      // Creation listeners must not fail the agent.
    }
  })
  ctx.on('agent/disposed', ({ agent }) => {
    try {
      sessionEnabled.delete(agent.id)
      currentTurn.delete(agent.id)
      remindedTurn.delete(agent.id)
    } catch {
      // Disposal is best-effort here.
    }
  })
  ctx.on('session/event', (session, event) => {
    try {
      if (event?.type !== 'turn/start') return
      currentTurn.set(session.id, event.data.turn)
      remindedTurn.delete(session.id)
    } catch {
      // Turn bookkeeping must never disturb the session feed.
    }
  })

  // 1. The standing policy: rendered only for a Session whose own switch is on.
  ctx.systemPrompt.section({
    name: 'plugin:process-cleanup',
    order: 10050,
    text: (context) => {
      const agent = context?.scope ?? context?.agent
      const sessionId = agent?.id
      if (typeof sessionId !== 'string' || sessionId.length === 0) return ''
      if (!enabledFor(sessionId)) return ''
      if (skipSubagents() && !isRootAgent(ctx, agent)) return ''
      if (goalInProgress(ctx, agent)) return ''
      return buildPolicy(mode())
    },
  })

  // 2. A short reminder after write-capable calls, so the model sees it while
  //    it still has steps left. It is a notice context, never a reply.
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    try {
      const reminder = reminderFor(ctx, exec, result, {
        enabledFor,
        mode,
        skipSubagents,
        currentTurn,
        remindedTurn,
      })
      if (reminder === undefined) return downstream
      const additionalContexts = [reminder, ...(downstream.additionalContexts ?? [])]
      if (downstream.kind === 'block') {
        return { kind: 'block', feedback: downstream.feedback, additionalContexts }
      }
      return { ...downstream, additionalContexts }
    } catch {
      return downstream
    }
  })

  mountSessionRoute(ctx, { enabledFor, setEnabled })
}

function reminderFor(ctx, exec, result, state) {
  const agent = exec?.agent
  if (agent === undefined || agent === null) return undefined
  const name = typeof exec.name === 'string' ? exec.name : ''
  if (!isMutationTool(name)) return undefined
  // A refused write never produced a file to clean up.
  if (result?.isError === true && WRITE_TOOLS.has(name)) return undefined
  if (!state.enabledFor(agent.id)) return undefined
  if (state.skipSubagents() && !isRootAgent(ctx, agent)) return undefined
  if (goalInProgress(ctx, agent)) return undefined

  const turn = state.currentTurn.get(agent.id) ?? 0
  if (!WRITE_TOOLS.has(name)) {
    if (state.remindedTurn.get(agent.id) === turn) return undefined
    state.remindedTurn.set(agent.id, turn)
  }

  const { root } = directoriesFor(ctx, agent)
  return {
    id: randomUUID(),
    role: 'user',
    content: [{
      type: 'text',
      text: buildReminder({ root, sessionId: agent.id, turn, mode: state.mode() }),
    }],
    // The source label is load-bearing: an unlabeled context would render as a
    // user prompt in derived history.
    source: { kind: 'process-cleanup', form: 'notice', summary: '收尾提醒' },
  }
}

/**
 * Browser-facing per-Session switch. There is no generated Remote for a local
 * bundle, so a loopback-only prefix route carries the two operations the
 * composer needs; the settings document stays the home of the global defaults.
 */
function mountSessionRoute(ctx, api) {
  const route = { kind: 'prefix', path: '/process-cleanup', handler: (req, res) => handleSessionRoute(req, res, api) }
  const attach = (scope) => {
    const webServer = optionalService(scope, 'webServer')
    if (webServer === undefined || typeof webServer.register !== 'function') return
    scope.effect(() => webServer.register(route))
  }
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (inner) => attach(inner))
      return
    }
  } catch {
    // Fall through to the direct read for older contexts.
  }
  attach(ctx)
}

async function handleSessionRoute(req, res, api) {
  try {
    if (!isLoopbackRequest(req)) {
      sendJson(res, 403, { error: 'forbidden' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname.replace(/^\/process-cleanup/, '').replace(/\/+$/, '')
    if (path !== '/session') {
      sendJson(res, 404, { error: 'not-found' })
      return
    }
    if (req.method === 'GET') {
      const sessionId = url.searchParams.get('id') ?? ''
      if (!SESSION_ID.test(sessionId)) {
        sendJson(res, 400, { error: 'bad-session' })
        return
      }
      sendJson(res, 200, { enabled: api.enabledFor(sessionId) })
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method-not-allowed' })
      return
    }
    if (!hasUiWriteHeader(req)) {
      sendJson(res, 403, { error: 'missing-ui-header' })
      return
    }
    const body = await readJsonBody(req, 4096)
    if (!SESSION_ID.test(String(body.sessionId ?? '')) || typeof body.enabled !== 'boolean') {
      sendJson(res, 400, { error: 'bad-request' })
      return
    }
    api.setEnabled(String(body.sessionId), body.enabled)
    sendJson(res, 200, { enabled: body.enabled === true })
  } catch (error) {
    try {
      sendJson(res, 400, { error: 'bad-request' })
    } catch {
      // The socket may already be gone.
    }
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(text)
}

function isLoopbackAddress(address) {
  if (address === undefined) return false
  return address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.')
}

function isLoopbackRequest(req) {
  return isLoopbackAddress(req.socket?.remoteAddress ?? undefined)
}

function hasUiWriteHeader(req) {
  const header = req.headers['x-process-cleanup-ui']
  return Array.isArray(header) ? header[0] === '1' : header === '1'
}

async function readJsonBody(req, limit) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > limit) throw new Error('body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return {}
  const value = JSON.parse(text)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('body must be an object')
  return value
}

/** Whether this agent is a runtime root rather than a delegated child. */
function isRootAgent(ctx, agent) {
  const agents = optionalService(ctx, 'agents')
  if (agents === undefined || typeof agents.roots !== 'function') return true
  try {
    return agents.roots().some((candidate) => candidate === agent || candidate.id === agent.id)
  } catch {
    return true
  }
}

/** Skip while a goal is active, paused, or blocked; a completed goal is cleanable. */
function goalInProgress(ctx, agent) {
  const goals = optionalService(ctx, 'goals')
  if (goals === undefined || typeof goals.get !== 'function') return false
  try {
    const view = goals.get(agent)
    return view !== undefined && view !== null && view.phase !== 'complete'
  } catch {
    return false
  }
}

/** Current session directory plus the workspace root used for the trash area. */
function directoriesFor(ctx, agent) {
  const session = agent?.session
  let cwd
  const workingDirectory = optionalService(ctx, 'workingDirectory')
  if (workingDirectory !== undefined && session !== undefined && typeof workingDirectory.get === 'function') {
    try {
      cwd = workingDirectory.get(session)
    } catch {
      cwd = undefined
    }
  }
  const root = session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) cwd = typeof root === 'string' && root.length > 0 ? root : process.cwd()
  return { cwd, root: typeof root === 'string' && root.length > 0 ? root : cwd }
}
