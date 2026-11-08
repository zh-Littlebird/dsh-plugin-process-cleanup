import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import {
  buildPolicy,
  buildReminder,
  isMutationTool,
  shortSessionId,
  trashDirFor,
} from '../policy.js'

const root = path.resolve('demo-workspace')

test('mutation tools are recognized', () => {
  for (const name of ['write', 'edit', 'pwsh', 'bash', 'subagent', 'workflow']) {
    assert.equal(isMutationTool(name), true, name)
  }
  for (const name of ['read', 'glob', 'grep', 'present', 'todo_write', 'web_search']) {
    assert.equal(isMutationTool(name), false, name)
  }
})

test('policy text follows the cleanup mode', () => {
  assert.match(buildPolicy('delete'), /直接删除/)
  assert.match(buildPolicy('trash'), /回收目录/)
  assert.match(buildPolicy('trash'), /\.dsh-trash/)
  assert.match(buildPolicy('trash'), /收尾提醒/)
})

test('short session ids strip the shared session prefix', () => {
  assert.equal(shortSessionId('session-ca78aeec-6e1b'), 'ca78aeec')
  assert.equal(shortSessionId('abcdef12-3456'), 'abcdef12')
  assert.equal(shortSessionId('!!'), 'session')
})

test('the trash directory is per session and per turn, forward-slashed', () => {
  const dir = trashDirFor(root, 'session-ca78aeec-6e1b', 7)
  assert.match(dir, /\.dsh-trash\/ca78aeec\/turn-7$/)
  assert.ok(!dir.includes('\\'))
})

test('the reminder names the mode target and never claims a turn-end check', () => {
  const trash = buildReminder({ root, sessionId: 'session-ca78aeec-6e1b', turn: 3, mode: 'trash' })
  assert.match(trash, /收尾提醒/)
  assert.match(trash, /\.dsh-trash\/ca78aeec\/turn-3/)
  assert.match(trash, /不要直接删除/)
  assert.doesNotMatch(trash, /自动收尾检查/)

  const remove = buildReminder({ root, sessionId: 'session-ca78aeec-6e1b', turn: 3, mode: 'delete' })
  assert.match(remove, /用精确路径删除/)
  assert.doesNotMatch(remove, /\.dsh-trash/)
})
