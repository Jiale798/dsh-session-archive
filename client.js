// session-archive — Client half.
//
// One pill in the composer dock showing this session's archive folder, with a
// panel that lists the files and buttons: 打开目录 / 复制路径 / 刷新。
// The host owns every fact; this module only draws and posts the reveal action.
window.__ModuleLoader__.load({
  id: '@local/session-archive',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    const POLL_MS = 4000

    const CSS = `
.sa-pill{display:inline-flex;align-items:center;gap:5px;height:24px;max-width:44vw;padding:0 8px;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:16px;cursor:pointer;white-space:nowrap;overflow:hidden}
@media (hover:hover){.sa-pill:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}}
.sa-pill:focus-visible{outline:1px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.sa-text{min-width:0;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
.sa-svg{flex:none;opacity:.85}
.sa-panel{position:fixed;z-index:2147483000;box-sizing:border-box;width:352px;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 10px 30px rgba(0,0,0,.26);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px}
.sa-head{display:flex;align-items:center;gap:6px;font-weight:600;margin-bottom:8px}
.sa-badge{margin-left:auto;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-weight:400;font-size:11px}
.sa-badge[data-live=true]{color:var(--dsw-alias-state-business-primary)}
.sa-path{margin:0 0 10px;padding:7px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:16px;word-break:break-all}
.sa-list{display:flex;flex-direction:column;gap:2px;margin:0 0 10px;max-height:180px;overflow:auto}
.sa-row{display:flex;align-items:center;gap:8px;padding:3px 4px;border-radius:6px}
.sa-row:hover{background:var(--dsw-alias-bg-layer-2)}
.sa-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px}
.sa-size{color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums}
.sa-actions{display:flex;gap:6px}
.sa-btn{flex:1;height:26px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}
@media (hover:hover){.sa-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}}
.sa-btn[data-primary=true]{border-color:transparent;background:var(--dsw-alias-state-business-primary);color:#fff}
.sa-btn:disabled{opacity:.5;cursor:default}
.sa-note{margin-top:8px;color:var(--dsw-alias-label-tertiary);font-size:11px;min-height:14px}
`

    function human(bytes) {
      const n = Number(bytes)
      if (!Number.isFinite(n) || n <= 0) return '0 B'
      if (n < 1024) return `${String(n)} B`
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
      return `${(n / 1024 / 1024).toFixed(2)} MB`
    }

    function useArchive(sessionId) {
      const [state, setState] = useState(null)
      const load = useCallback(async () => {
        if (!sessionId) return
        try {
          const res = await fetch(`/session-archive/state?session=${encodeURIComponent(sessionId)}`, { cache: 'no-store' })
          setState(await res.json())
        } catch {
          setState((prev) => (prev && prev.ok ? { ...prev, stale: true } : prev))
        }
      }, [sessionId])
      useEffect(() => {
        let alive = true
        let timer = 0
        const tick = async () => {
          await load()
          if (alive) timer = setTimeout(() => { void tick() }, POLL_MS)
        }
        void tick()
        return () => { alive = false; clearTimeout(timer) }
      }, [load])
      return [state, load]
    }

    const FOLDER = h('svg', { className: 'sa-svg', width: 14, height: 14, viewBox: '0 0 24 24', 'aria-hidden': true },
      h('path', {
        d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round',
      }))

    function Panel({ state, rect, panelRef, onReload }) {
      const [note, setNote] = useState('')
      const left = Math.min(Math.max(8, rect.left), Math.max(8, (window.innerWidth || 1280) - 360))
      const style = { left: `${String(left)}px`, bottom: `${String((window.innerHeight || 800) - rect.top + 8)}px` }
      const files = Array.isArray(state.files) ? state.files : []

      const reveal = async () => {
        setNote('正在打开…')
        try {
          const res = await fetch(`/session-archive/reveal?session=${encodeURIComponent(state.sessionId ?? '')}`)
          const json = await res.json()
          setNote(json.ok ? '已在文件管理器中打开' : `打开失败：${json.error ?? res.status}`)
        } catch (error) {
          setNote(`打开失败：${String(error.message ?? error)}`)
        }
      }

      const copy = async () => {
        try {
          await navigator.clipboard.writeText(state.dir)
          setNote('路径已复制')
        } catch {
          setNote(state.dir)
        }
      }

      return h('div', { ref: panelRef, className: 'sa-panel', role: 'dialog', 'aria-label': '会话归档', style },
        h('div', { className: 'sa-head' },
          FOLDER,
          h('span', null, '会话归档'),
          h('span', { className: 'sa-badge', 'data-live': state.live === true }, state.live ? '记录中' : '已停止')),
        h('p', { className: 'sa-path' }, state.dir ?? '—'),
        files.length > 0
          ? h('div', { className: 'sa-list' }, files.map((file) => h('div', { key: file.name, className: 'sa-row' },
            h('span', { className: 'sa-name' }, file.name),
            h('span', { className: 'sa-size' }, human(file.bytes)))))
          : h('div', { className: 'sa-list' }, h('div', { className: 'sa-row' }, h('span', { className: 'sa-name' }, '目录为空'))),
        h('div', { className: 'sa-actions' },
          h('button', { type: 'button', className: 'sa-btn', 'data-primary': true, onClick: () => { void reveal() } }, '打开目录'),
          h('button', { type: 'button', className: 'sa-btn', onClick: () => { void copy() } }, '复制路径'),
          h('button', { type: 'button', className: 'sa-btn', onClick: () => { void onReload() } }, '刷新')),
        h('div', { className: 'sa-note' }, note || `序号 ${String(state.seq ?? '—')} · ${String(state.eventCount ?? 0)} 个事件`))
    }

    function ArchivePill(props) {
      const sessionId = props.sessionId
      const [state, reload] = useArchive(sessionId)
      const [open, setOpen] = useState(false)
      const [rect, setRect] = useState(null)
      const pillRef = useRef(null)
      const panelRef = useRef(null)

      useEffect(() => {
        if (!open) return undefined
        const measure = () => {
          if (pillRef.current) setRect(pillRef.current.getBoundingClientRect())
        }
        const onDown = (event) => {
          const target = event.target
          if (panelRef.current && panelRef.current.contains(target)) return
          if (pillRef.current && pillRef.current.contains(target)) return
          setOpen(false)
        }
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
        measure()
        document.addEventListener('pointerdown', onDown, true)
        window.addEventListener('keydown', onKey, true)
        window.addEventListener('resize', measure)
        return () => {
          document.removeEventListener('pointerdown', onDown, true)
          window.removeEventListener('keydown', onKey, true)
          window.removeEventListener('resize', measure)
        }
      }, [open])

      if (!state || state.ok !== true) return null
      const seq = String(state.seq ?? '').padStart(3, '0')
      const text = `${seq} · 归档`
      const pill = h('button', {
        ref: pillRef,
        type: 'button',
        className: 'sa-pill',
        'data-composer-stat': 'session-archive',
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        'aria-label': `会话归档 ${state.folder ?? ''}`,
        title: state.dir ?? text,
        onClick: () => {
          if (pillRef.current) setRect(pillRef.current.getBoundingClientRect())
          setOpen(!open)
        },
      }, FOLDER, h('span', { className: 'sa-text' }, text))

      const panel = open && rect
        ? createPortal(h(Panel, { state: { ...state, sessionId }, rect, panelRef, onReload: reload }), document.body)
        : null
      return h(React.Fragment, null, pill, panel)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.plugin = 'session-archive'
          style.dataset.pluginCss = 'session-archive/pill.css'
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'session-archive: styles')

        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'session-archive',
          order: 3,
          inject: (sessionId) => ({ sessionId }),
        }, ArchivePill))
      },
    }
  },
})
