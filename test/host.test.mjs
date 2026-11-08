import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

/** Volatile config references, the shape the Loader hands to `apply`. */
function refs(overrides = {}) {
  const values = {
    defaultEnabled: true,
    mode: 'trash',
    skipSubagents: true,
    ...overrides,
  }
  return {
    defaultEnabled: { get: () => values.defaultEnabled },
    mode: { get: () => values.mode },
    skipSubagents: { get: () => values.skipSubagents },
    values,
  }
}

function harness({ config = refs(), services = {} } = {}) {
  const listeners = new Map()
  const sections = []
  const routes = []
  const webServer = {
    register(route) {
      routes.push(route)
      return () => {}
    },
  }
  const ctx = {
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
    },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {}
    },
    effect(effect) {
      return effect() ?? (() => {})
    },
    get(name) {
      if (name === 'webServer') return webServer
      return services[name]
    },
  }
  apply(ctx, config)
  return {
    sections,
    routes,
    fire(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
    async postExecute(exec, result = { isError: false }) {
      const listenersFor = listeners.get('tools/post-execute') ?? []
      const call = async (index) => {
        const listener = listenersFor[index]
        if (listener === undefined) return { kind: 'allow' }
        return listener(exec, result, () => call(index + 1))
      }
      return call(0)
    },
  }
}

/** One HTTP request against the plugin's session route. */
async function callRoute(routes, { method = 'GET', url = '/process-cleanup/session', body, headers = {}, remote = '127.0.0.1' } = {}) {
  const route = routes.find((candidate) => candidate.path === '/process-cleanup')
  assert.ok(route, 'session route mounted')
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = {
    method,
    url,
    headers,
    socket: { remoteAddress: remote },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
  const out = { status: 0, json: undefined }
  const res = {
    writeHead(status) {
      out.status = status
    },
    end(text) {
      out.json = text ? JSON.parse(text) : undefined
    },
  }
  await route.handler(req, res)
  return out
}

function agentFixture(id = 'session-aaaaaaaa-1111') {
  const agent = {
    id,
    session: { id, header: { cwd: 'C:\\work\\demo' } },
  }
  return agent
}

function execFor(agent, name, args) {
  return { agent, name, arguments: args, callId: `call-${name}` }
}

const toolServices = {
  tools: { schemas: () => [{ name: 'pwsh' }, { name: 'write' }] },
  workingDirectory: { get: () => 'C:\\work\\demo' },
}

test('policy section is per Session and starts from the global default', () => {
  const config = refs({ defaultEnabled: true })
  const agent = agentFixture()
  const { sections } = harness({ config, services: { agents: { roots: () => [agent] } } })
  assert.equal(sections.length, 1)
  assert.match(sections[0].text({ scope: agent }), /任务收尾/)

  config.values.defaultEnabled = false
  assert.match(sections[0].text({ scope: agent }), /任务收尾/)
  const other = agentFixture('session-bbbbbbbb-2222')
  assert.equal(sections[0].text({ scope: other }), '')
  assert.equal(sections[0].text({}), '')
})

test('a write inside an enabled session adds one notice reminder', async () => {
  const agent = agentFixture()
  const { postExecute, fire } = harness({ services: { ...toolServices, agents: { roots: () => [agent] } } })
  fire('session/event', { id: agent.id }, { type: 'turn/start', data: { turn: 4 } })

  const decision = await postExecute(execFor(agent, 'write', { file_path: 'merge.py' }))
  assert.equal(decision.additionalContexts.length, 1)
  const reminder = decision.additionalContexts[0]
  assert.equal(reminder.role, 'user')
  assert.equal(reminder.source.kind, 'process-cleanup')
  assert.equal(reminder.source.form, 'notice')
  assert.match(reminder.content[0].text, /收尾提醒/)
  assert.match(reminder.content[0].text, /\.dsh-trash\/aaaaaaaa\/turn-4/)
  assert.doesNotMatch(reminder.content[0].text, /自动收尾检查/)
})

test('reminders respect the session switch, tool kind, and goal state', async () => {
  const agent = agentFixture()
  const config = refs({ defaultEnabled: false })
  const { postExecute } = harness({
    config,
    services: { ...toolServices, agents: { roots: () => [agent] } },
  })

  // Off by default.
  assert.equal((await postExecute(execFor(agent, 'write', { file_path: 'a.py' }))).additionalContexts, undefined)

  // A read-only tool never draws one.
  config.values.defaultEnabled = true
  assert.equal((await postExecute(execFor(agent, 'read', { file_path: 'a.py' }))).additionalContexts, undefined)

  // A refused write did not create a file.
  assert.equal((await postExecute(execFor(agent, 'write', { file_path: 'a.py' }), { isError: true })).additionalContexts, undefined)
})

test('shell reminders are once per turn; write reminders are per call', async () => {
  const agent = agentFixture()
  const { postExecute, fire } = harness({ services: { ...toolServices, agents: { roots: () => [agent] } } })
  fire('session/event', { id: agent.id }, { type: 'turn/start', data: { turn: 1 } })

  const first = await postExecute(execFor(agent, 'pwsh', { command: 'python a.py' }))
  const second = await postExecute(execFor(agent, 'pwsh', { command: 'python b.py' }))
  assert.equal(first.additionalContexts.length, 1)
  assert.equal(second.additionalContexts, undefined)

  const writeA = await postExecute(execFor(agent, 'write', { file_path: 'a.py' }))
  const writeB = await postExecute(execFor(agent, 'write', { file_path: 'b.py' }))
  assert.equal(writeA.additionalContexts.length, 1)
  assert.equal(writeB.additionalContexts.length, 1)

  // A new turn re-arms the shell reminder.
  fire('session/event', { id: agent.id }, { type: 'turn/start', data: { turn: 2 } })
  const nextTurn = await postExecute(execFor(agent, 'pwsh', { command: 'python c.py' }))
  assert.equal(nextTurn.additionalContexts.length, 1)
  assert.match(nextTurn.additionalContexts[0].content[0].text, /turn-2/)
})

test('subagents and unfinished goals do not draw reminders', async () => {
  const agent = agentFixture()
  let phase = 'active'
  const { postExecute } = harness({
    services: {
      ...toolServices,
      agents: { roots: () => [] },
      goals: { get: () => ({ phase }) },
    },
  })

  assert.equal((await postExecute(execFor(agent, 'write', { file_path: 'a.py' }))).additionalContexts, undefined)

  phase = 'complete'
  // Still a child agent, so still skipped.
  assert.equal((await postExecute(execFor(agent, 'write', { file_path: 'a.py' }))).additionalContexts, undefined)
})

test('an unfinished goal suppresses the reminder for a root session', async () => {
  const agent = agentFixture()
  const config = refs({ skipSubagents: false })
  let phase = 'active'
  const { postExecute, fire } = harness({
    config,
    services: { ...toolServices, agents: { roots: () => [agent] }, goals: { get: () => ({ phase }) } },
  })
  fire('session/event', { id: agent.id }, { type: 'turn/start', data: { turn: 1 } })
  assert.equal((await postExecute(execFor(agent, 'write', { file_path: 'a.py' }))).additionalContexts, undefined)

  phase = 'complete'
  assert.equal((await postExecute(execFor(agent, 'write', { file_path: 'a.py' }))).additionalContexts.length, 1)
})

test('a session switch is local: enabling one session never enables another', async () => {
  const config = refs({ defaultEnabled: false })
  const first = agentFixture('session-aaaaaaaa-1111')
  const second = agentFixture('session-bbbbbbbb-2222')
  const { routes, postExecute, fire } = harness({
    config,
    services: { ...toolServices, agents: { roots: () => [first, second] } },
  })
  fire('agent/created', { agent: first })
  fire('agent/created', { agent: second })
  fire('session/event', { id: first.id }, { type: 'turn/start', data: { turn: 1 } })
  fire('session/event', { id: second.id }, { type: 'turn/start', data: { turn: 1 } })

  assert.equal((await postExecute(execFor(first, 'write', { file_path: 'a.py' }))).additionalContexts, undefined)

  const on = await callRoute(routes, {
    method: 'POST',
    body: { sessionId: first.id, enabled: true },
    headers: { 'x-process-cleanup-ui': '1' },
  })
  assert.equal(on.json.enabled, true)

  assert.equal((await postExecute(execFor(first, 'write', { file_path: 'a.py' }))).additionalContexts.length, 1)
  assert.equal((await postExecute(execFor(second, 'write', { file_path: 'b.py' }))).additionalContexts, undefined)

  const state = await callRoute(routes, { url: `/process-cleanup/session?id=${first.id}` })
  assert.equal(state.json.enabled, true)
})

test('the session route rejects remote callers and unmarked writes', async () => {
  const { routes } = harness()
  assert.equal((await callRoute(routes, { remote: '10.0.0.5', url: '/process-cleanup/session?id=x' })).status, 403)
  assert.equal((await callRoute(routes, { method: 'POST', body: { sessionId: 'x', enabled: true } })).status, 403)
  assert.equal((await callRoute(routes, { url: '/process-cleanup/session?id=bad id!' })).status, 400)
})
