/**
 * session-archive — 每个 DSH 会话一个带序号的文件夹（v1.1）。
 *
 * 行为：
 *   1. 新会话产生  -> 建 `<根>/001-未命名会话/`，内含 transcript.md、events.jsonl、meta.json。
 *   2. 会话日志增长 -> 增量追加；`meta.json` 记 lastSeq，恢复会话时从断点续写，不重复。
 *   3. 会话有了标题 -> 文件夹原地改名成 `<seq>-<标题>`，序号永不变化。
 *   4. events.jsonl 超过 maxEventLogBytes -> 轮转成 events.1.jsonl、events.2.jsonl…
 *
 * 设计要点：
 *   - 序号来自 `<根>/.index.json`，映射 sessionId -> { seq, folder, title }，
 *     原子写入（tmp + rename），崩了也不会丢号；索引损坏时从目录名前缀恢复。
 *   - 一切派生自会话日志这条唯一事实源：标题直接折叠 `session/title` 事件，
 *     不依赖 session-title 服务。
 *   - 默认跳过 subagent 会话；默认不接管点击插件前就已结束的历史会话。
 *   - 所有监听注册在 ctx.effect 里，禁用插件即停止写入。
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

export const name = 'session-archive'

export const inject = ['sessions']

const UNTITLED = '未命名会话'
const SEQ_DIGITS = 3
const TITLE_MAX_CHARS = 40
const RENAME_DEBOUNCE_MS = 300
/** 每这么多个事件把 meta.json 落一次盘，给崩溃后的续写留一个最近的断点。 */
const META_FLUSH_EVENTS = 20
/** 索引表 README 的重建节流。 */
const README_MIN_INTERVAL_MS = 2000
/** 每这么多条事件检查一次 events.jsonl 的体积，避免每条都 statSync。 */
const ROTATE_CHECK_EVENTS = 20
const ARGS_PREVIEW_CHARS = 240
const RESULT_PREVIEW_CHARS = 1200

// ── 设置 ────────────────────────────────────────────────────────────────────

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  return join(homedir(), '.dsh')
}

function settings(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const text = (value, fallback) => (typeof value === 'string' && value.trim() !== '' ? value : fallback)
  const num = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback)
  return {
    baseDir: text(raw.baseDir, ''),
    folderName: text(raw.folderName, '会话归档'),
    includeSubagents: raw.includeSubagents === true,
    keepEventLog: raw.keepEventLog !== false,
    // slim = 去掉逐 token 流、截断工具结果（默认）；full = 原样存
    eventLogMode: raw.eventLogMode === 'full' ? 'full' : 'slim',
    transcript: raw.transcript !== false,
    adoptExisting: raw.adoptExisting === true,
    maxEventLogBytes: num(raw.maxEventLogBytes, 8 * 1024 * 1024),
    argsPreview: num(raw.argsPreview, ARGS_PREVIEW_CHARS),
    resultPreview: num(raw.resultPreview, RESULT_PREVIEW_CHARS),
  }
}

function baseFor(options, session) {
  if (options.baseDir !== '') return options.baseDir
  const cwd = session?.header?.cwd
  if (typeof cwd === 'string' && cwd.trim() !== '') return join(cwd, options.folderName)
  // 没有记录工作目录的会话（或启动预热）跟随进程启动目录，与「每个会话工作目录」口径一致。
  try {
    return join(process.cwd(), options.folderName)
  } catch {
    return join(dshHome(), 'session-archive')
  }
}

// ── 路径与时间 ──────────────────────────────────────────────────────────────

/** 去掉 Windows 不允许出现在路径段里的字符，并限制长度。 */
function safeSegment(value) {
  const cleaned = String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ')
    .replace(/[\u200b-\u200f\u2028\u2029\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
  const sliced = [...cleaned].slice(0, TITLE_MAX_CHARS).join('').trim()
  return sliced === '' ? UNTITLED : sliced
}

function pad(seq) {
  return String(seq).padStart(SEQ_DIGITS, '0')
}

function stamp(ms) {
  const d = new Date(typeof ms === 'number' ? ms : Date.now())
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function clip(text, max) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  return `${value.slice(0, max)}…（共 ${value.length} 字，已截断）`
}

// ── 消息取文本 ──────────────────────────────────────────────────────────────

/**
 * 取消息正文。`skipToolCalls` 用于助手消息：工具调用由 `tool/call` 事件单独渲染。
 */
function textOf(content, skipToolCalls = false) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string' && block.text !== '') parts.push(block.text)
        break
      case 'image':
        parts.push('[图片]')
        break
      case 'file': {
        const fileName = block.attachment?.name
        parts.push(fileName ? `[文件 ${fileName}]` : '[文件]')
        break
      }
      case 'tool-call':
        if (!skipToolCalls) parts.push(`→ 调用 ${block.name}(${String(block.arguments ?? '')})`)
        break
      case 'tool-addition':
        parts.push(`+ 工具 ${block.toolName}`)
        break
      case 'tool-removal':
        parts.push(`- 工具 ${block.toolName}`)
        break
      default:
        break
    }
  }
  return parts.join('\n').trim()
}

function quoted(text) {
  return text.split('\n').map((line) => `> ${line}`).join('\n')
}

/** 折叠日志里的最新标题，不依赖任何服务。 */
function latestTitle(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type === 'session/title' && typeof event.data?.title === 'string') {
      const title = event.data.title.trim()
      if (title !== '') return title
    }
  }
  return ''
}

/** 折叠日志里的路由（provider/model），给 meta 用。 */
function latestRoute(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const config = events[i]?.data?.header?.config
    if (config && typeof config.model === 'string') {
      return { provider: config.provider ?? '', model: config.model }
    }
  }
  return null
}

/** 累计 token 用量。 */
function foldUsage(events) {
  const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 0 }
  for (const event of events) {
    if (event?.type !== 'assistant/message' || !event.data?.usage) continue
    const usage = event.data.usage
    total.calls += 1
    total.inputTokens += Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0
    total.outputTokens += Number.isFinite(usage.outputTokens) ? usage.outputTokens : 0
    total.cacheReadTokens += Number.isFinite(usage.cacheReadTokens) ? usage.cacheReadTokens : 0
    total.cacheWriteTokens += Number.isFinite(usage.cacheWriteTokens) ? usage.cacheWriteTokens : 0
    total.reasoningTokens += Number.isFinite(usage.reasoningTokens) ? usage.reasoningTokens : 0
  }
  return total.calls === 0 ? null : total
}

// ── 索引 + 目录 ─────────────────────────────────────────────────────────────

class Store {
  constructor(baseDir) {
    this.baseDir = baseDir
    this.indexPath = join(baseDir, '.index.json')
    this.index = { version: 2, nextSeq: 1, sessions: {} }
    this.readmeAt = 0
    this.readmeTimer = null
    this.load()
  }

  load() {
    try {
      mkdirSync(this.baseDir, { recursive: true })
    } catch {
      // 建不出来时后续写入会各自报错并记日志。
    }
    try {
      if (existsSync(this.indexPath)) {
        const parsed = JSON.parse(readFileSync(this.indexPath, 'utf8'))
        if (parsed && typeof parsed === 'object' && parsed.sessions && typeof parsed.sessions === 'object') {
          this.index = {
            version: 2,
            nextSeq: Number.isSafeInteger(parsed.nextSeq) && parsed.nextSeq > 0 ? parsed.nextSeq : 1,
            sessions: parsed.sessions,
          }
        }
      }
    } catch {
      this.index = { version: 2, nextSeq: 1, sessions: {} }
    }
    this.index.nextSeq = Math.max(this.index.nextSeq, this.scanNextSeq())
    this.save()
    this.ensureGitignore()
    this.hydrate()
  }

  /** 老索引没有 lastSeq：从历史文件补一次统计，之后都走 meta 缓存。 */
  hydrate() {
    let touched = false
    for (const record of Object.values(this.index.sessions)) {
      if (!record || typeof record !== 'object') continue
      if (Number.isInteger(record.lastSeq) && record.lastSeq >= 0) continue
      this.backfill(record, 32 * 1024 * 1024)
      touched = true
    }
    if (touched) {
      this.save()
      this.rebuildReadme()
    }
  }

  /** 索引缺失或损坏时，从已有文件夹的数字前缀恢复排序。 */
  scanNextSeq() {
    try {
      return readdirSync(this.baseDir).reduce((max, entry) => {
        const match = /^(\d{1,4})-/.exec(entry)
        return match ? Math.max(max, Number.parseInt(match[1], 10) + 1) : max
      }, 1)
    } catch {
      return 1
    }
  }

  save() {
    try {
      const tmp = `${this.indexPath}.tmp`
      writeFileSync(tmp, `${JSON.stringify(this.index, null, 2)}\n`, 'utf8')
      renameSync(tmp, this.indexPath)
    } catch {
      // 索引写失败不影响会话继续追加。
    }
  }

  /** 归档目录落在 git 仓库里时不污染工作树。 */
  ensureGitignore() {
    const file = join(this.baseDir, '.gitignore')
    try {
      if (!existsSync(file)) writeFileSync(file, '*\n!.gitignore\n', 'utf8')
    } catch {
      // 尽力而为。
    }
  }

  /** 从 events 文件末尾读出最大的 seq，作为最精确的续写断点。 */
  lastEventSeq(record) {
    const dir = join(this.baseDir, record.folder)
    let names = []
    try {
      names = readdirSync(dir).filter((name) => /^events(\.\d+)?\.jsonl$/.test(name))
    } catch {
      return -1
    }
    if (names.length === 0) return -1
    // events.jsonl 是最新的；轮转文件编号越大越新。
    const rank = (name) => (name === 'events.jsonl' ? Number.MAX_SAFE_INTEGER : Number(/(\d+)/.exec(name)?.[1] ?? 0))
    names.sort((a, b) => rank(b) - rank(a))
    for (const name of names) {
      const seq = this.tailSeq(join(dir, name))
      if (seq >= 0) return seq
    }
    return -1
  }

  /** 读文件末尾的一段，倒着找第一行能解析出 seq 的 JSON。 */
  tailSeq(file) {
    let fd = null
    try {
      const size = statSync(file).size
      if (size === 0) return -1
      const span = Math.min(size, 16 * 1024)
      const buffer = Buffer.alloc(span)
      fd = openSync(file, 'r')
      readSync(fd, buffer, 0, span, size - span)
      const lines = buffer.toString('utf8').split('\n').filter((line) => line.trim() !== '')
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
          const event = JSON.parse(lines[i])
          if (Number.isInteger(event?.seq)) return event.seq
        } catch {
          continue
        }
      }
      return -1
    } catch {
      return -1
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd)
        } catch {
          // 忽略关闭失败。
        }
      }
    }
  }

  ensure(session, title) {
    let record = this.index.sessions[session.id]
    if (!record || typeof record !== 'object' || typeof record.folder !== 'string') {
      const seq = this.index.nextSeq
      this.index.nextSeq = seq + 1
      record = {
        seq,
        folder: `${pad(seq)}-${safeSegment(title || UNTITLED)}`,
        title: title || '',
        createdAt: Date.now(),
        lastSeq: -1,
      }
      this.index.sessions[session.id] = record
      this.save()
    }
    if (!Number.isInteger(record.lastSeq)) record.lastSeq = -1
    this.ensureDir(record)
    // index 的 lastSeq 只在个别时点落盘，meta.json 才是每次写入后最新的那份。
    // 再用 events 文件末尾的 seq 兜底（进程被杀时 meta 可能落后），取三者最大值，
    // 保证重新接管会话时不会把已经写过的事件再写一遍。
    try {
      const previous = JSON.parse(readFileSync(this.path(record, 'meta.json'), 'utf8'))
      const fromMeta = Number.isInteger(previous?.lastSeq) && previous.lastSeq >= 0
        ? previous.lastSeq
        : (Number.isInteger(previous?.eventCount) && previous.eventCount > 0 ? previous.eventCount - 1 : -1)
      if (fromMeta > record.lastSeq) record.lastSeq = fromMeta
    } catch {
      // 没有 meta 或不可读，沿用索引里的值。
    }
    const fromTail = this.lastEventSeq(record)
    if (fromTail > record.lastSeq) record.lastSeq = fromTail
    return record
  }

  path(record, file) {
    return join(this.baseDir, record.folder, file)
  }

  /** 确保某个会话目录存在（用户手工删掉后下一条事件到来时重建）。 */
  ensureDir(record) {
    try {
      mkdirSync(join(this.baseDir, record.folder), { recursive: true })
    } catch {
      // 交给写入方各自报错。
    }
  }

  /** 改名成 `<seq>-<标题>`，序号不变；目标已存在或占用时保留原目录名。 */
  retitle(session, title) {
    const record = this.index.sessions[session.id]
    if (!record) return
    const wanted = `${pad(record.seq)}-${safeSegment(title || UNTITLED)}`
    if (record.folder !== wanted) {
      const from = join(this.baseDir, record.folder)
      const to = join(this.baseDir, wanted)
      try {
        if (existsSync(from) && !existsSync(to)) {
          renameSync(from, to)
          record.folder = wanted
        }
      } catch {
        // 被占用/权限不足：保留旧目录，标题仍写进 meta.json。
      }
    }
    record.title = title || record.title || ''
    this.save()
  }

  /** 索引表重建有 IO，事件密集时按时间节流，最后一次一定补上。 */
  scheduleReadme() {
    const now = Date.now()
    const wait = Math.max(0, README_MIN_INTERVAL_MS - (now - this.readmeAt))
    if (wait === 0 && this.readmeTimer === null) {
      this.rebuildReadme()
      return
    }
    if (this.readmeTimer !== null) return
    this.readmeTimer = setTimeout(() => {
      this.readmeTimer = null
      this.rebuildReadme()
    }, wait)
    this.readmeTimer.unref?.()
  }

  /** 根目录下的总索引，随时可读，按序号排列。 */
  rebuildReadme() {
    if (this.readmeTimer !== null) {
      clearTimeout(this.readmeTimer)
      this.readmeTimer = null
    }
    this.readmeAt = Date.now()
    const rows = Object.entries(this.index.sessions)
      .map(([id, record]) => ({ id, ...record }))
      .filter((row) => typeof row.seq === 'number')
      .sort((a, b) => a.seq - b.seq)
    const lines = [
      '# 会话归档索引',
      '',
      `共 ${rows.length} 个会话。文件夹名 = 序号 + 会话标题；会话改标题时文件夹跟着改名，序号不变。`,
      '',
      '| 序号 | 标题 | 创建时间 | 事件数 | 会话 ID | 文件夹 |',
      '| --- | --- | --- | --- | --- | --- |',
      ...rows.map((row) => {
        const title = (row.title || UNTITLED).replace(/\|/g, '\\|')
        return `| ${pad(row.seq)} | ${title} | ${stamp(row.createdAt)} | ${this.countOf(row)} | \`${row.id}\` | \`${row.folder}\` |`
      }),
      '',
      `_更新于 ${stamp(Date.now())}_`,
      '',
    ]
    try {
      writeFileSync(join(this.baseDir, 'README.md'), lines.join('\n'), 'utf8')
    } catch {
      // 尽力而为。
    }
  }

  /** 索引里没记事件数时，退回读该目录的 meta.json。 */
  countOf(record) {
    if (Number.isInteger(record.lastSeq) && record.lastSeq >= 0) return record.lastSeq + 1
    try {
      const meta = JSON.parse(readFileSync(this.path(record, 'meta.json'), 'utf8'))
      if (Number.isInteger(meta?.lastSeq) && meta.lastSeq >= 0) return meta.lastSeq + 1
      if (Number.isInteger(meta?.eventCount) && meta.eventCount > 0) return meta.eventCount
    } catch {
      // 没有 meta。
    }
    return 0
  }

  /**
   * 从 events.jsonl（含轮转文件）里补出索引缺失的统计。
   * 只读一次，结果写回 meta，后续启动直接命中。
   * @param record 会话记录
   * @param bytesCap 最多读取的字节数，避免超大历史文件拖慢启动
   */
  backfill(record, bytesCap) {
    if (Number.isInteger(record.lastSeq) && record.lastSeq >= 0) return
    if (typeof record.folder !== 'string' || record.folder === '') return
    const dir = join(this.baseDir, record.folder)
    let meta = null
    try {
      meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
    } catch {
      meta = null
    }
    if (Number.isInteger(meta?.lastSeq) && meta.lastSeq >= 0) {
      record.lastSeq = meta.lastSeq
      return
    }
    if (Number.isInteger(meta?.eventCount) && meta.eventCount > 0) {
      record.lastSeq = meta.eventCount - 1
      return
    }

    const parts = []
    try {
      for (const name of readdirSync(dir)) {
        if (/^events(\.\d+)?\.jsonl$/.test(name)) parts.push(name)
      }
    } catch {
      return
    }
    // events.jsonl 是当前文件，其余按编号从大到小（越新编号越大）。
    parts.sort((a, b) => {
      const na = a === 'events.jsonl' ? Number.MAX_SAFE_INTEGER : Number(/(\d+)/.exec(a)?.[1] ?? 0)
      const nb = b === 'events.jsonl' ? Number.MAX_SAFE_INTEGER : Number(/(\d+)/.exec(b)?.[1] ?? 0)
      return na - nb
    })

    let lastSeq = -1
    let route = meta?.route ?? null
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 0 }
    let read = 0
    for (const name of parts) {
      if (read >= bytesCap) break
      const file = join(dir, name)
      let text = ''
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      read += text.length
      for (const line of text.split('\n')) {
        if (line === '') continue
        let event = null
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        if (Number.isInteger(event?.seq) && event.seq > lastSeq) lastSeq = event.seq
        if (event?.type === 'request/header') {
          const config = event.data?.header?.config
          if (config && typeof config.model === 'string') route = { provider: config.provider ?? '', model: config.model }
        }
        if (event?.type === 'assistant/message' && event.data?.usage) {
          usage.calls += 1
          for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
            if (Number.isFinite(event.data.usage[key])) usage[key] += event.data.usage[key]
          }
        }
      }
    }

    if (lastSeq >= 0) {
      record.lastSeq = lastSeq
    }
    try {
      const merged = {
        ...(meta && typeof meta === 'object' ? meta : {}),
        sessionId: meta?.sessionId ?? '(imported)',
        seq: record.seq,
        title: record.title || meta?.title || '',
        folder: record.folder,
        lastSeq: record.lastSeq,
        eventCount: Number.isInteger(record.lastSeq) ? record.lastSeq + 1 : 0,
        route,
        usage: usage.calls > 0 ? usage : (meta?.usage ?? null),
        updatedAt: Date.now(),
      }
      writeFileSync(join(dir, 'meta.json'), `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
    } catch {
      // meta 写不进去也不影响索引里的字段。
    }
  }
}

// ── 事件瘦身 ────────────────────────────────────────────────────────────────

/** 这些事件只对引擎自身有意义，对复盘没用，默认不进 events.jsonl。 */
const DROP_EVENT_TYPES = new Set([
  'assistant/attempt',
  'llm/retry',
  'llm/retry-started',
  'request/context',
  'image/offload',
  'job/registered',
  'job/settled',
])

/**
 * 把一条事件裁成「够复盘、不臃肿」的版本。
 * `assistant/message` 的 `stream`（逐 token 时间片）占了日志七成以上，去掉它；
 * 工具结果按 resultPreview 截断，避免一条命令输出撑爆整个文件。
 */
function slimEvent(event, options) {
  if (event.type === 'assistant/message' && event.data && 'stream' in event.data) {
    const { stream, ...rest } = event.data
    return { ...event, data: rest }
  }
  if (event.type === 'tool/result') {
    const message = event.data?.message
    const text = textOf(message?.content)
    if (text.length > options.resultPreview) {
      return {
        ...event,
        data: {
          ...event.data,
          message: {
            ...message,
            content: [{ type: 'text', text: clip(text, options.resultPreview) }],
          },
        },
      }
    }
  }
  return event
}

/** 这条事件是否进 events.jsonl，以及进去时是否要瘦身。 */
function eventForLog(event, options) {
  if (options.eventLogMode === 'full') return event
  if (DROP_EVENT_TYPES.has(event.type)) return null
  return slimEvent(event, options)
}

// ── 事件渲染 ────────────────────────────────────────────────────────────────

function headerText(session) {
  const header = session.header ?? {}
  return [
    `# 会话记录 · ${session.id}`,
    '',
    `- 创建时间：${stamp(header.createdAt)}`,
    `- 工作目录：\`${header.cwd ?? '—'}\``,
    `- 会话 ID：\`${session.id}\``,
    '',
    '---',
    '',
    '',
  ].join('\n')
}

/** 一个日志事件 -> 0..n 段 markdown。 */
function render(event, options) {
  switch (event.type) {
    case 'user/message': {
      const message = event.data
      if (message?.source?.kind !== 'user') return ''
      const text = textOf(message.content)
      return text === '' ? '' : `### 用户 · ${stamp(event.time)}\n\n${quoted(text)}\n\n`
    }
    case 'assistant/message': {
      const message = event.data?.message
      if (!message) return ''
      // 工具调用由 tool/call 事件渲染，助手文本只取正文，避免同一段参数出现两次。
      const text = textOf(message.content, true)
      if (text === '') return ''
      const head = message.interrupted === true ? '### 助手（中断）' : '### 助手'
      const usage = event.data?.usage
      const cost = usage
        ? `\n\n<sub>tokens：入 ${usage.inputTokens ?? 0} / 出 ${usage.outputTokens ?? 0}</sub>`
        : ''
      return `${head} · ${stamp(event.time)}\n\n${text}${cost}\n\n`
    }
    case 'tool/call': {
      const args = typeof event.data?.arguments === 'string' ? event.data.arguments : ''
      return `- 🔧 \`${event.data?.name ?? 'tool'}\` ${clip(args, options.argsPreview)}\n`
    }
    case 'tool/result': {
      const message = event.data?.message
      const text = textOf(message?.content)
      if (text === '') return ''
      const shown = clip(text, options.resultPreview)
      const mark = message?.isError === true ? '⚠️ 失败' : '结果'
      return `- ${mark}：${shown.replace(/\n/g, '\n  ')}\n`
    }
    case 'turn/end':
      return '\n---\n\n'
    default:
      return ''
  }
}

// ── 插件本体 ────────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  const options = settings(config)
  const stores = new Map()
  const tracked = new Map()

  const storeFor = (session) => {
    const base = baseFor(options, session)
    let store = stores.get(base)
    if (!store) {
      store = new Store(base)
      stores.set(base, store)
    }
    return store
  }

  // 启动时先把「当前工作目录/会话归档」这个根打开：它会顺手把历史索引里缺失的
  // 事件数与用量补齐，README 索引表也就不会出现一片 0。
  try {
    storeFor(null)
  } catch (error) {
    ctx.logger?.warn?.(`session-archive: 打开归档根失败: ${String(error)}`)
  }

  /** 追加到会话目录；目录被手工删掉时重建一次再试。 */
  const appendTo = (entry, file, text) => {
    const target = entry.store.path(entry.record, file)
    try {
      appendFileSync(target, text, 'utf8')
      return
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        ctx.logger?.warn?.(`session-archive: ${file} 追加失败: ${String(error)}`)
        return
      }
    }
    entry.store.ensureDir(entry.record)
    try {
      appendFileSync(target, text, 'utf8')
    } catch (error) {
      ctx.logger?.warn?.(`session-archive: ${file} 追加失败: ${String(error)}`)
    }
  }
  /** events.jsonl 超过上限就轮转成 events.1.jsonl、events.2.jsonl… */
  const rotateIfNeeded = (entry) => {
    // statSync 有系统调用成本，按事件数抽样检查即可（每 ROTATE_CHECK_EVENTS 条）。
    entry.sinceRotate += 1
    if (entry.sinceRotate < ROTATE_CHECK_EVENTS) return
    entry.sinceRotate = 0
    const target = entry.store.path(entry.record, 'events.jsonl')
    let size = 0
    try {
      size = statSync(target).size
    } catch {
      return
    }
    if (size < options.maxEventLogBytes) return
    const dir = join(entry.store.baseDir, entry.record.folder)
    try {
      let index = 1
      while (existsSync(join(dir, `events.${index}.jsonl`))) index += 1
      renameSync(target, join(dir, `events.${index}.jsonl`))
    } catch (error) {
      ctx.logger?.warn?.(`session-archive: events.jsonl 轮转失败: ${String(error)}`)
    }
  }

  const writeMeta = (entry) => {
    const header = entry.session.header ?? {}
    const meta = {
      sessionId: entry.session.id,
      seq: entry.record.seq,
      title: entry.record.title || '',
      folder: entry.record.folder,
      createdAt: header.createdAt ?? null,
      archivedAt: entry.record.createdAt,
      cwd: header.cwd ?? null,
      parentSession: header.parentSession ?? null,
      origin: header.origin ?? null,
      updatedAt: Date.now(),
      lastSeq: entry.record.lastSeq,
      eventCount: Number.isInteger(entry.record.lastSeq) ? entry.record.lastSeq + 1 : 0,
      route: entry.route ?? null,
      usage: entry.usage ?? null,
    }
    try {
      writeFileSync(entry.store.path(entry.record, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
    } catch (error) {
      ctx.logger?.warn?.(`session-archive: meta.json 写入失败 ${entry.session.id}: ${String(error)}`)
    }
    // 索引表重建是有 IO 的，事件密集时按时间节流，收尾时再补一次。
    entry.store.scheduleReadme()
  }

  const scheduleRename = (entry, title) => {
    entry.pendingTitle = title
    if (entry.timer !== null) return
    entry.timer = setTimeout(() => {
      entry.timer = null
      try {
        entry.store.retitle(entry.session, entry.pendingTitle)
        writeMeta(entry)
      } catch (error) {
        ctx.logger?.warn?.(`session-archive: 改名失败: ${String(error)}`)
      }
    }, RENAME_DEBOUNCE_MS)
    entry.timer.unref?.()
  }

  const addUsage = (entry, usage) => {
    if (!usage || typeof usage !== 'object') return
    entry.usage ??= { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 0 }
    const total = entry.usage
    total.calls += 1
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
      if (Number.isFinite(usage[key])) total[key] += usage[key]
    }
  }

  const consume = (entry, event) => {
    // 断点续写：本生命周期里已经写过的事件不再写第二遍。
    if (Number.isInteger(event.seq) && event.seq <= entry.lastWritten) return
    if (options.keepEventLog) {
      const logged = eventForLog(event, options)
      if (logged !== null) {
        rotateIfNeeded(entry)
        appendTo(entry, 'events.jsonl', `${JSON.stringify(logged)}\n`)
      }
    }
    if (Number.isInteger(event.seq)) {
      entry.lastWritten = event.seq
      entry.record.lastSeq = event.seq
      // meta 每写若干事件落一次盘；崩溃后靠它算出续写断点，不至于重放半条日志。
      entry.sinceMeta += 1
      if (entry.sinceMeta >= META_FLUSH_EVENTS) {
        entry.sinceMeta = 0
        writeMeta(entry)
      }
    }

    if (event.type === 'session/title') {
      const title = typeof event.data?.title === 'string' ? event.data.title.trim() : ''
      if (title !== '') scheduleRename(entry, title)
      return
    }
    if (event.type === 'request/header') {
      const route = event.data?.header?.config
      if (route && typeof route.model === 'string') {
        entry.route = { provider: route.provider ?? '', model: route.model }
      }
    }
    if (event.type === 'assistant/message') addUsage(entry, event.data?.usage)
    if (!options.transcript) return
    let body = ''
    try {
      body = render(event, options)
    } catch {
      body = ''
    }
    if (body === '') return
    appendTo(entry, 'transcript.md', body)
  }

  /**
   * 建立（或取回）一个会话的归档条目。
   * @param session 会话
   * @param replayUpTo 回放到哪个 seq（不含）；默认回放整条日志
   */
  const adopt = (session, replayUpTo) => {
    const existing = tracked.get(session.id)
    if (existing) return existing
    const header = session.header ?? {}
    if (header.origin === 'subagent' && !options.includeSubagents) return undefined

    const upto = typeof replayUpTo === 'number' && replayUpTo >= 0 ? replayUpTo : session.seq
    let history = []
    try {
      history = upto > 0 ? session.snapshotEvents(0, upto) : []
    } catch {
      history = []
    }

    const store = storeFor(session)
    const record = store.ensure(session, latestTitle(history))

    const transcriptPath = store.path(record, 'transcript.md')
    const fresh = !existsSync(transcriptPath)
    // 目录里可能已有上一条生命周期的记录：只补 lastSeq 之后的部分，避免重复。
    const resumeFrom = Number.isInteger(record.lastSeq) && record.lastSeq >= 0 && !fresh
      ? record.lastSeq + 1
      : 0
    // 已经落盘的那一段只用来重建统计基线，不再写第二遍。
    const written = resumeFrom > 0 ? history.filter((event) => Number.isInteger(event.seq) && event.seq < resumeFrom) : []

    const entry = {
      session,
      store,
      record,
      pendingTitle: record.title || '',
      timer: null,
      route: latestRoute(written),
      usage: foldUsage(written),
      sinceMeta: 0,
      sinceRotate: 0,
      lastWritten: resumeFrom - 1,
    }

    if (options.transcript && fresh) {
      try {
        writeFileSync(transcriptPath, headerText(session), 'utf8')
      } catch (error) {
        ctx.logger?.warn?.(`session-archive: transcript.md 初始化失败: ${String(error)}`)
      }
    }
    tracked.set(session.id, entry)

    for (const event of history) {
      try {
        consume(entry, event)
      } catch (error) {
        ctx.logger?.warn?.(`session-archive: 回放失败: ${String(error)}`)
      }
    }
    writeMeta(entry)
    return entry
  }

  // 启用插件时按配置接管已存在的会话。
  if (options.adoptExisting) {
    try {
      for (const session of ctx.sessions?.list?.() ?? []) {
        try {
          adopt(session)
        } catch (error) {
          ctx.logger?.warn?.(`session-archive: 接管既有会话失败: ${String(error)}`)
        }
      }
    } catch (error) {
      ctx.logger?.warn?.(`session-archive: 枚举会话失败: ${String(error)}`)
    }
  }

  ctx.effect(() => {
    const offCreated = ctx.on('session/created', (session) => {
      try {
        adopt(session)
      } catch (error) {
        ctx.logger?.warn?.(`session-archive: 新建归档失败: ${String(error)}`)
      }
    }, { global: true })

    const offEvent = ctx.on('session/event', (session, event) => {
      let entry = tracked.get(session.id)
      if (!entry) {
        try {
          // 先把本次事件之前的历史补上，当前事件交给下面统一处理，避免重复写入。
          entry = adopt(session, event.seq)
        } catch (error) {
          ctx.logger?.warn?.(`session-archive: 惰性接管失败: ${String(error)}`)
          return
        }
      }
      if (!entry) return
      try {
        consume(entry, event)
      } catch (error) {
        ctx.logger?.warn?.(`session-archive: 事件处理失败: ${String(error)}`)
      }
    }, { global: true })

    const offDisposed = ctx.on('session/disposed', (session) => {
      const entry = tracked.get(session.id)
      if (!entry) return
      if (entry.timer !== null) {
        clearTimeout(entry.timer)
        entry.timer = null
      }
      try {
        entry.store.retitle(session, entry.pendingTitle)
        writeMeta(entry)
      } catch {
        // 尽力而为。
      }
      tracked.delete(session.id)
    }, { global: true })

    return () => {
      offCreated()
      offEvent()
      offDisposed()
      for (const entry of tracked.values()) {
        if (entry.timer !== null) clearTimeout(entry.timer)
        entry.timer = null
        try {
          entry.store.retitle(entry.session, entry.pendingTitle)
          writeMeta(entry)
        } catch {
          // 卸载时尽力把最后一次标题与 meta 落盘。
        }
      }
      tracked.clear()
    }
  }, 'session-archive: archive listeners')

  const where = options.baseDir !== '' ? options.baseDir : `每个会话工作目录下的「${options.folderName}」`
  ctx.logger?.info?.(`session-archive: 会话归档已启用（${where}）`)

  // ── HTTP 面：给 Web 端的归档 pill 提供状态与「打开目录」动作 ───────────────
  const describe = (sessionId) => {
    const id = typeof sessionId === 'string' ? sessionId : ''
    if (id === '') return { ok: false, error: 'missing session' }
    let entry = tracked.get(id)
    if (!entry) {
      // 还没被本进程接管的会话：从索引里找出它的目录，读 meta。
      for (const store of stores.values()) {
        const record = store.index.sessions[id]
        if (record) {
          const dir = join(store.baseDir, record.folder)
          const files = []
          let meta = null
          try {
            for (const name of readdirSync(dir)) {
              try {
                files.push({ name, bytes: statSync(join(dir, name)).size })
              } catch {
                files.push({ name, bytes: 0 })
              }
            }
            meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
          } catch {
            // 目录或 meta 暂时不在。
          }
          const count = Number.isInteger(record.lastSeq) && record.lastSeq >= 0
            ? record.lastSeq + 1
            : (Number.isInteger(meta?.eventCount) ? meta.eventCount : 0)
          return {
            ok: true,
            live: false,
            seq: record.seq,
            title: record.title || '',
            folder: record.folder,
            dir,
            base: store.baseDir,
            eventCount: count,
            route: meta?.route ?? null,
            usage: meta?.usage ?? null,
            files: files.sort((a, b) => a.name.localeCompare(b.name)),
          }
        }
      }
      return { ok: false, error: 'unknown session' }
    }
    const dir = join(entry.store.baseDir, entry.record.folder)
    const files = []
    try {
      for (const name of readdirSync(dir)) {
        try {
          files.push({ name, bytes: statSync(join(dir, name)).size })
        } catch {
          files.push({ name, bytes: 0 })
        }
      }
    } catch {
      // 目录暂时不在。
    }
    return {
      ok: true,
      live: true,
      seq: entry.record.seq,
      title: entry.record.title || '',
      folder: entry.record.folder,
      dir,
      base: entry.store.baseDir,
      eventCount: Number.isInteger(entry.record.lastSeq) ? entry.record.lastSeq + 1 : 0,
      route: entry.route ?? null,
      usage: entry.usage ?? null,
      files: files.sort((a, b) => a.name.localeCompare(b.name)),
    }
  }

  if (typeof ctx.inject !== 'function') return
  ctx.inject(['webServer'], (webCtx) => {
    const server = webCtx.get('webServer')
    if (typeof server?.register !== 'function') return

    const sendJson = (res, code, body) => {
      const text = JSON.stringify(body)
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(text)
    }

    webCtx.effect(() => server.register({
      kind: 'exact',
      path: '/session-archive/state',
      handler: (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          sendJson(res, 200, describe(url.searchParams.get('session') ?? ''))
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }), 'session-archive: state route')

    webCtx.effect(() => server.register({
      kind: 'exact',
      path: '/session-archive/reveal',
      handler: (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const state = describe(url.searchParams.get('session') ?? '')
          if (!state.ok) {
            sendJson(res, 404, state)
            return
          }
          if (process.platform === 'win32') {
            spawn('explorer.exe', [state.dir], { detached: true, stdio: 'ignore' }).unref()
          } else if (process.platform === 'darwin') {
            spawn('open', [state.dir], { detached: true, stdio: 'ignore' }).unref()
          } else {
            spawn('xdg-open', [state.dir], { detached: true, stdio: 'ignore' }).unref()
          }
          sendJson(res, 200, { ok: true, dir: state.dir })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }), 'session-archive: reveal route')
  })
}
