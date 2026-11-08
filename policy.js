/**
 * Pure decisions for the process-file cleanup plugin.
 *
 * Nothing here touches Cordis, the filesystem, or React: this module renders
 * the standing policy and the per-turn reminder the Host injects through the
 * tool pipeline. Keeping it pure makes the wording and path rules testable
 * without booting a Harness.
 */

import path from 'node:path'

/** Tools that name a file they wrote. */
export const WRITE_TOOLS = new Set(['write', 'edit'])

/** Shell tools whose commands may create or modify files. */
export const SHELL_TOOLS = new Set(['pwsh', 'bash'])

/** Tools that run another agent which may write into the same workspace. */
export const CHILD_WORK_TOOLS = new Set(['subagent', 'subagent_fork', 'workflow'])

/** Marker directory for trash mode, relative to the session workspace. */
export const TRASH_DIR = '.dsh-trash'

/** Whether a tool can change the workspace and should draw a reminder. */
export function isMutationTool(name) {
  return WRITE_TOOLS.has(name) || SHELL_TOOLS.has(name) || CHILD_WORK_TOOLS.has(name)
}

/** Short, filesystem-friendly session key for a trash subdirectory. */
export function shortSessionId(sessionId) {
  const cleaned = String(sessionId ?? '').replace(/[^A-Za-z0-9]/g, '')
  // Every Session id starts with `session-`; keeping that prefix would make the
  // first eight characters identical across sessions.
  const distinctive = cleaned.replace(/^session/i, '')
  const key = distinctive.length > 0 ? distinctive : cleaned
  return key.length > 0 ? key.slice(0, 8) : 'session'
}

/** Forward-slashed absolute path, safe to paste into pwsh or bash. */
function displayAbsolute(target) {
  return target.split(path.sep).join('/')
}

/** The per-turn trash directory, under the session workspace root. */
export function trashDirFor(root, sessionId, turn) {
  const directory = path.join(root, TRASH_DIR, shortSessionId(sessionId), `turn-${turn}`)
  return displayAbsolute(directory)
}

/** The always-on policy section: how process files are defined and handled. */
export function buildPolicy(mode) {
  const how = mode === 'delete'
    ? '清理方式：直接删除（rm / Remove-Item），只使用精确路径。'
    : `清理方式：移动到工作区内的回收目录 ${TRASH_DIR}/ 下（每一轮的精确路径由收尾提醒给出），不要直接删除。`
  return [
    '【任务收尾：过程文件】',
    '你每完成一项会产生文件的工作，在给出最终答复之前，先清理本轮产生的过程文件。',
    '- 过程文件：只为完成本次任务临时创建、不属于交付物、之后不再需要的文件，例如临时脚本、一次性数据与中间结果、日志、截图、构建产物、探测用的副本。',
    '- 必须保留：用户要求的交付物；用户已有或明确要求保留的文件；源码、配置、依赖、.git；后续仍要使用的中间产物。',
    '- 只操作工作目录内的精确路径，禁止通配符批量操作，禁止操作工作目录之外的内容。',
    '- 不确定是否属于交付物时保留，并在答复中用一行列出，请用户确认。',
    how,
  ].join('\n')
}

/**
 * The reminder injected after a write-capable tool call. It is a notice, not a
 * reply: it never enters the turn's final answer, so the user-facing answer
 * stays the last assistant message of the turn.
 */
export function buildReminder({ root, sessionId, turn, mode }) {
  const lines = [
    '【收尾提醒】如果本轮产生了文件，在给出最终答复前，先判断任务是否已经交付：',
    '- 任务未完成，或这些文件下一轮还要用：保留，不做清理。',
    '- 任务已交付：清理为完成本轮工作而临时创建、且不属于交付物的文件（临时脚本、中间数据、日志、截图、构建产物等）。',
  ]
  if (mode === 'delete') {
    lines.push('- 清理方式：用精确路径删除这些文件，不要删除交付物、用户已有文件、源码、配置与依赖。')
  } else {
    lines.push(`- 清理方式：把这些文件移动到 ${trashDirFor(root, sessionId, turn)}（目录不存在就先创建；重名时加序号），不要直接删除。`)
  }
  lines.push('- 只使用工作目录内的精确路径，禁止通配符与工作目录之外的内容。')
  return lines.join('\n')
}
