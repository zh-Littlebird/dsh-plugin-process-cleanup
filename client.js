/**
 * dsh-plugin-process-cleanup — Web half.
 *
 * Two surfaces over two different scopes:
 *  - Settings → General: the GLOBAL policy — cleanup mode and whether a newly
 *    opened Session starts with cleanup on (off by default).
 *  - Composer tool row: the CURRENT Session's own switch. It starts from the
 *    global default and only ever affects that Session.
 *
 * The per-Session switch talks to the Host through the plugin's loopback-only
 * `/process-cleanup/session` route; a local bundle has no generated Remote.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-process-cleanup',
  factory(require) {
    'use strict'
    const React = require('react')
    const h = React.createElement
    const ENTRY_ID = 'process-cleanup'
    const SESSION_ENDPOINT = '/process-cleanup/session'

    const COPY = {
      zh: {
        title: '任务收尾清理',
        description:
          '全局设置：清理方式，以及新会话是否默认开启。每个会话的实际开关在输入框左侧，只影响当前会话。',
        defaultLabel: '新会话默认开启',
        modeLabel: '清理方式',
        modeTrash: '移到回收目录',
        modeDelete: '直接删除',
        trashHint: '回收目录：工作区内的 .dsh-trash/。',
        loading: '正在读取设置…',
        unavailable: '设置暂不可用：插件未启用，或当前页面未连接。',
        readonly: '当前页面没有写入权限。',
        saveFailed: '保存失败，请重试。',
        switchLabel: '新会话默认开启收尾清理',
        composerOn: '本会话收尾清理：开（仅影响当前会话）',
        composerOff: '本会话收尾清理：关（仅影响当前会话）',
        composerBusy: '正在保存本会话的收尾清理开关…',
        composerUnavailable: '无法读取本会话的收尾清理状态',
      },
      en: {
        title: 'Task cleanup',
        description:
          'Global settings: the cleanup mode and whether a newly opened session starts with cleanup on. Each session has its own switch in the composer, affecting only that session.',
        defaultLabel: 'New sessions start on',
        modeLabel: 'Cleanup mode',
        modeTrash: 'Move to trash',
        modeDelete: 'Delete',
        trashHint: 'Trash location: .dsh-trash/ inside the workspace.',
        loading: 'Reading settings…',
        unavailable: 'Settings unavailable: the plugin is not enabled, or this page is not connected.',
        readonly: 'This page cannot write settings.',
        saveFailed: 'Could not save. Try again.',
        switchLabel: 'New sessions start with cleanup enabled',
        composerOn: 'Task cleanup for this session: on (this session only)',
        composerOff: 'Task cleanup for this session: off (this session only)',
        composerBusy: 'Saving this session’s cleanup switch…',
        composerUnavailable: 'Could not read this session’s cleanup switch',
      },
    }

    function useCopy(ctx) {
      const subscribe = React.useCallback((listener) => ctx.locale.subscribe(listener), [ctx])
      const getSnapshot = React.useCallback(() => ctx.locale.getSnapshot(), [ctx])
      const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      const active = String(snapshot?.active ?? '')
      return active.toLowerCase().startsWith('zh') ? COPY.zh : COPY.en
    }

    function useForm(ctx) {
      const form = React.useMemo(() => ctx.configForms.get(ENTRY_ID), [ctx])
      const subscribe = React.useCallback((listener) => form.subscribe(listener), [form])
      const getSnapshot = React.useCallback(() => form.getSnapshot(), [form])
      const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      return { form, snapshot }
    }

    function Switch({ checked, disabled, onToggle, label }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': checked,
          'aria-label': label,
          title: label,
          disabled,
          onClick: onToggle,
          style: {
            width: 34,
            height: 20,
            flex: 'none',
            borderRadius: 10,
            border: 'none',
            padding: 0,
            position: 'relative',
            cursor: disabled ? 'default' : 'pointer',
            background: checked ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)',
            opacity: disabled ? 0.55 : 1,
            transition: 'background 120ms ease',
          },
        },
        h('span', {
          'aria-hidden': true,
          style: {
            position: 'absolute',
            top: 2,
            left: checked ? 16 : 2,
            width: 16,
            height: 16,
            borderRadius: '50%',
            background: '#ffffff',
            boxShadow: '0 1px 2px rgba(0, 0, 0, 0.28)',
            transition: 'left 120ms ease',
          },
        }),
      )
    }

    function ModeGroup({ value, disabled, onChange, copy }) {
      const options = [
        { id: 'trash', label: copy.modeTrash },
        { id: 'delete', label: copy.modeDelete },
      ]
      return h(
        'div',
        {
          role: 'radiogroup',
          'aria-label': copy.modeLabel,
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            padding: 2,
            borderRadius: 8,
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-base)',
          },
        },
        options.map((option) => {
          const selected = option.id === value
          return h(
            'button',
            {
              key: option.id,
              type: 'button',
              role: 'radio',
              'aria-checked': selected,
              disabled,
              onClick: () => {
                if (!selected) onChange(option.id)
              },
              style: {
                border: 'none',
                borderRadius: 6,
                padding: '3px 8px',
                fontSize: 12,
                lineHeight: '16px',
                whiteSpace: 'nowrap',
                cursor: disabled ? 'default' : 'pointer',
                color: selected ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
                background: selected ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
                fontWeight: selected ? 500 : 400,
              },
            },
            option.label,
          )
        }),
      )
    }

    function GeneralRow(ctx) {
      const copy = useCopy(ctx)
      const { form, snapshot } = useForm(ctx)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const ready = snapshot.status === 'ready'
      const writable = ready && snapshot.writable === true
      const value = snapshot.value ?? {}
      const startsOn = value.defaultEnabled === true
      const mode = value.mode === 'delete' ? 'delete' : 'trash'

      const write = async (field, next) => {
        if (!writable || busy) return
        setBusy(true)
        setError(null)
        try {
          const accepted = await form.set(field, next)
          if (!accepted) setError(copy.saveFailed)
        } catch {
          setError(copy.saveFailed)
        } finally {
          setBusy(false)
        }
      }

      const statusLine = !ready
        ? snapshot.status === 'unavailable'
          ? copy.unavailable
          : copy.loading
        : !writable
          ? copy.readonly
          : null

      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            padding: '12px 0',
          },
        },
        h(
          'div',
          { style: { flex: '1 1 auto', minWidth: 0 } },
          h(
            'div',
            { style: { fontSize: 14, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' } },
            copy.title,
          ),
          h(
            'div',
            {
              style: {
                marginTop: 2,
                fontSize: 12,
                lineHeight: 1.5,
                color: 'var(--dsw-alias-label-secondary)',
              },
            },
            copy.description,
            mode === 'trash' ? ` ${copy.trashHint}` : '',
          ),
          statusLine !== null &&
            h(
              'div',
              {
                style: {
                  marginTop: 4,
                  fontSize: 12,
                  color: 'var(--dsw-alias-label-secondary)',
                },
              },
              statusLine,
            ),
          error !== null &&
            h(
              'div',
              {
                style: {
                  marginTop: 4,
                  fontSize: 12,
                  color: 'var(--dsw-alias-state-error-primary)',
                },
              },
              error,
            ),
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 12, flex: 'none' } },
          h(ModeGroup, {
            value: mode,
            disabled: !writable || busy,
            onChange: (next) => void write('mode', next),
            copy,
          }),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 } },
            h(
              'span',
              { style: { fontSize: 11, lineHeight: '14px', color: 'var(--dsw-alias-label-secondary)' } },
              copy.defaultLabel,
            ),
            h(Switch, {
              checked: startsOn,
              disabled: !writable || busy,
              onToggle: () => void write('defaultEnabled', !startsOn),
              label: copy.switchLabel,
            }),
          ),
        ),
      )
    }

    function Broom({ active }) {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: 16,
          height: 16,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: active ? 1.9 : 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', { d: 'M15 3.2 20.8 9' }),
        h('path', { d: 'M18.2 6.5 10.2 14.5' }),
        h('path', { d: 'M10.2 14.5c-1.9 1.9-2.7 3.9-2.4 6.1 2.2.3 4.2-.5 6.1-2.4' }),
        h('path', { d: 'M7.8 20.6 4.6 23.4' }),
      )
    }

    function ComposerButton(ctx, props) {
      const copy = useCopy(ctx)
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : undefined
      const [enabled, setEnabled] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [failed, setFailed] = React.useState(false)

      React.useEffect(() => {
        if (sessionId === undefined) return undefined
        let cancelled = false
        setFailed(false)
        fetch(`${SESSION_ENDPOINT}?id=${encodeURIComponent(sessionId)}`, {
          headers: { accept: 'application/json' },
        })
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
          .then((value) => {
            if (!cancelled) setEnabled(value?.enabled === true)
          })
          .catch(() => {
            if (!cancelled) setFailed(true)
          })
        return () => {
          cancelled = true
        }
      }, [sessionId])

      const toggle = async () => {
        if (sessionId === undefined || busy) return
        const next = !enabled
        setBusy(true)
        setEnabled(next)
        setFailed(false)
        try {
          const response = await fetch(SESSION_ENDPOINT, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-process-cleanup-ui': '1',
            },
            body: JSON.stringify({ sessionId, enabled: next }),
          })
          if (!response.ok) throw new Error(String(response.status))
          const value = await response.json()
          setEnabled(value?.enabled === true)
        } catch {
          setEnabled(!next)
          setFailed(true)
        } finally {
          setBusy(false)
        }
      }

      const label = sessionId === undefined
        ? copy.composerUnavailable
        : busy
          ? copy.composerBusy
          : enabled
            ? copy.composerOn
            : copy.composerOff

      return h(
        'button',
        {
          type: 'button',
          title: label,
          'aria-label': label,
          'aria-pressed': enabled,
          disabled: sessionId === undefined || busy,
          onClick: () => void toggle(),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 26,
            height: 26,
            padding: 0,
            borderRadius: 6,
            border: 'none',
            cursor: sessionId === undefined || busy ? 'default' : 'pointer',
            background: enabled ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
            color: failed
              ? 'var(--dsw-alias-state-error-primary)'
              : enabled
                ? 'var(--dsw-alias-brand-primary)'
                : 'var(--dsw-alias-label-secondary)',
            opacity: sessionId === undefined || busy ? 0.55 : 1,
          },
        },
        h(Broom, { active: enabled }),
      )
    }

    function apply(ctx) {
      ctx.slots.inject('settings.general.item', () =>
        ctx.slots.register(
          { name: 'settings.general.item', id: 'process-cleanup', order: 25 },
          function TaskCleanupRow() {
            return GeneralRow(ctx)
          },
        ),
      )
      ctx.slots.inject('conversation.input.left', () =>
        ctx.slots.register(
          { name: 'conversation.input.left', id: 'process-cleanup-toggle', order: 10 },
          function TaskCleanupToggle(props) {
            return ComposerButton(ctx, props)
          },
        ),
      )
    }

    return {
      inject: ['slots', 'configForms', 'locale'],
      apply,
    }
  },
})
