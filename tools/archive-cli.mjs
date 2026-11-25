#!/usr/bin/env node
/**
 * session-archive CLI — 查索引、看单会话、按关键词搜历史。
 *
 * 用法（任意目录可跑，默认在当前目录的「会话归档」下找）：
 *
 *   node tools/archive-cli.mjs list                 # 列出全部会话
 *   node tools/archive-cli.mjs show 003             # 看某个序号/标题/会话 ID 的详情
 *   node tools/archive-cli.mjs search 关键词        # 在 transcript 里全文搜索
 *   node tools/archive-cli.mjs stats                # 体积与用量汇总
 *
 * 公共参数：
 *   --base <目录>     归档根目录（默认 ./会话归档，或 $DSH_SESSION_ARCHIVE）
 *   --json            输出 JSON
 *   --limit <n>       搜索返回条数上限（默认 30）
 *   --context <n>     搜索命中前后各显示几行（默认 0）
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const argv = process.argv.slice(2)
const command = argv[0] ?? 'list'

function flag(name, fallback) {
  const index = argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = argv[index + 1]
  return value === undefined || value.startsWith('--') ? true : value
}

const base = resolve(String(flag('base', process.env.DSH_SESSION_ARCHIVE ?? join(process.cwd(), '会话归档'))))
const asJson = flag('json', false) === true
const limit = Number(flag('limit', 30)) || 30
const contextLines = Number(flag('context', 0)) || 0

function die(message) {
  console.error(message)
  process.exit(1)
}

if (!existsSync(base)) die(`找不到归档目录：${base}\n用 --base 指定，或先让插件跑一次。`)

const indexPath = join(base, '.index.json')
const index = existsSync(indexPath)
  ? JSON.parse(readFileSync(indexPath, 'utf8'))
  : { sessions: {} }

function rows() {
  return Object.entries(index.sessions ?? {})
    .map(([id, record]) => ({ id, ...record }))
    .filter((row) => typeof row.seq === 'number')
    .sort((a, b) => a.seq - b.seq)
}

function dirOf(row) {
  return join(base, row.folder)
}

function fileSize(file) {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

function human(bytes) {
  if (!bytes) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1048576).toFixed(2)} MB`
}

function stamp(ms) {
  const d = new Date(typeof ms === 'number' ? ms : Date.now())
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function matchRow(rowsIn, needle) {
  const text = String(needle).trim()
  if (text === '') return []
  const asSeq = Number.parseInt(text, 10)
  return rowsIn.filter((row) =>
    (Number.isFinite(asSeq) && row.seq === asSeq)
    || row.folder === text
    || row.folder.startsWith(`${text}-`)
    || row.id === text
    || (row.title ?? '').includes(text))
}

// ── 命令 ────────────────────────────────────────────────────────────────────

function cmdList() {
  const all = rows()
  if (asJson) {
    console.log(JSON.stringify(all, null, 2))
    return
  }
  if (all.length === 0) {
    console.log('还没有归档的会话。')
    return
  }
  const width = Math.max(...all.map((row) => [...(row.title || '未命名会话')].length), 4)
  console.log(`${'序号'.padEnd(4)}  ${'标题'.padEnd(width)}  事件数  创建时间`)
  for (const row of all) {
    const title = (row.title || '未命名会话').padEnd(width)
    const count = Number.isInteger(row.lastSeq) && row.lastSeq >= 0 ? row.lastSeq + 1 : 0
    console.log(`${String(row.seq).padStart(4)}  ${title}  ${String(count).padStart(6)}  ${stamp(row.createdAt)}`)
  }
}

function cmdShow(needle) {
  const hit = matchRow(rows(), needle)
  if (hit.length === 0) die(`没有匹配「${needle}」的会话。`)
  const row = hit[0]
  const dir = dirOf(row)
  const metaPath = join(dir, 'meta.json')
  const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : null
  const files = existsSync(dir)
    ? readdirSync(dir).map((name) => ({ name, bytes: fileSize(join(dir, name)) }))
    : []
  const result = { ...row, dir, files, meta }
  if (asJson) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(`序号   ${row.seq}`)
  console.log(`标题   ${row.title || '未命名会话'}`)
  console.log(`会话   ${row.id}`)
  console.log(`目录   ${dir}`)
  console.log(`创建   ${stamp(row.createdAt)}`)
  if (meta?.route) console.log(`模型   ${meta.route.provider} / ${meta.route.model}`)
  if (meta?.usage) {
    const u = meta.usage
    console.log(`用量   入 ${u.inputTokens} / 出 ${u.outputTokens} / 缓存读 ${u.cacheReadTokens ?? 0}（${u.calls} 次调用）`)
  }
  console.log('文件')
  for (const file of files) console.log(`       ${file.name.padEnd(20)} ${human(file.bytes)}`)
}

function cmdSearch(needle) {
  const text = String(needle ?? '').trim()
  if (text === '') die('用法：search <关键词>')
  const hits = []
  for (const row of rows()) {
    const transcript = join(dirOf(row), 'transcript.md')
    if (!existsSync(transcript)) continue
    const lines = readFileSync(transcript, 'utf8').split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].includes(text)) continue
      hits.push({
        seq: row.seq,
        title: row.title || '未命名会话',
        folder: row.folder,
        line: i + 1,
        text: lines[i].trim().slice(0, 200),
        context: contextLines > 0
          ? lines.slice(Math.max(0, i - contextLines), i + contextLines + 1).join('\n')
          : undefined,
      })
      if (hits.length >= limit) break
    }
    if (hits.length >= limit) break
  }
  if (asJson) {
    console.log(JSON.stringify(hits, null, 2))
    return
  }
  if (hits.length === 0) {
    console.log(`没有找到「${text}」。`)
    return
  }
  for (const hit of hits) {
    console.log(`${String(hit.seq).padStart(4)}  ${hit.title}  :${hit.line}`)
    console.log(`      ${hit.text}`)
    if (hit.context) console.log(hit.context.split('\n').map((line) => `      ${line}`).join('\n'))
  }
  console.log(`\n共 ${hits.length} 条${hits.length >= limit ? `（已达上限 ${limit}）` : ''}。`)
}

function cmdStats() {
  const all = rows()
  let transcript = 0
  let events = 0
  let usageIn = 0
  let usageOut = 0
  let calls = 0
  for (const row of all) {
    const dir = dirOf(row)
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      if (name === 'transcript.md') transcript += fileSize(join(dir, name))
      else if (/^events(\.\d+)?\.jsonl$/.test(name)) events += fileSize(join(dir, name))
    }
    const metaPath = join(dir, 'meta.json')
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
        usageIn += meta.usage?.inputTokens ?? 0
        usageOut += meta.usage?.outputTokens ?? 0
        calls += meta.usage?.calls ?? 0
      } catch {
        // 跳过坏 meta。
      }
    }
  }
  const summary = {
    base,
    sessions: all.length,
    transcriptBytes: transcript,
    eventBytes: events,
    totalBytes: transcript + events,
    inputTokens: usageIn,
    outputTokens: usageOut,
    calls,
  }
  if (asJson) {
    console.log(JSON.stringify(summary, null, 2))
    return
  }
  console.log(`归档根   ${base}`)
  console.log(`会话数   ${all.length}`)
  console.log(`records  ${human(transcript)}（transcript）+ ${human(events)}（events）= ${human(transcript + events)}`)
  console.log(`用量     入 ${usageIn} / 出 ${usageOut}，共 ${calls} 次模型调用`)
}

// ── 分发 ────────────────────────────────────────────────────────────────────

switch (command) {
  case 'list':
  case 'ls':
    cmdList()
    break
  case 'show':
  case 'cat':
    cmdShow(argv[1])
    break
  case 'search':
  case 'grep':
    cmdSearch(argv[1])
    break
  case 'stats':
  case 'stat':
    cmdStats()
    break
  case 'help':
  case '--help':
  case '-h':
    console.log(`session-archive CLI

用法：node tools/archive-cli.mjs <命令> [参数]

命令：
  list                    列出全部已归档会话
  show <序号|标题|id>     查看单个会话的目录、文件与用量
  search <关键词>         在 transcript.md 里全文搜索
  stats                   体积与 token 用量汇总

公共参数：
  --base <目录>           归档根目录（默认 ./会话归档，或 $DSH_SESSION_ARCHIVE）
  --json                  输出 JSON
  --limit <n>             搜索返回条数上限（默认 30）
  --context <n>           搜索命中前后各显示几行（默认 0）`)
    break
  default:
    die(`未知命令：${command}\n可用：list | show <序号> | search <关键词> | stats`)
}
