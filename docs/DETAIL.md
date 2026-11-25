# 会话归档 · Session archive

每个新会话自动获得一个**带序号的文件夹**，会话标题一改，文件夹跟着改名，序号始终不变。输入框下方多一个 `003 · 归档` 胶囊，点开能看文件、打开目录、复制路径。

## 它做什么

| 时机 | 动作 |
| --- | --- |
| `session/created` | 建 `001-未命名会话/`，写入 `transcript.md`、`events.jsonl`、`meta.json` |
| `session/event` | 增量追加对话内容与原始事件，不重扫、不重写 |
| `session/title` | 目录原地改名成 `001-<会话标题>`（防抖 300ms） |
| `session/disposed` | 补做最后一次改名与 meta 落盘 |
| 每 20 条事件 | meta 落一次盘，作为崩溃后的续写断点 |
| `events.jsonl` 超过 8 MB | 轮转成 `events.1.jsonl`、`events.2.jsonl`… |

断点续写取「索引 lastSeq / meta lastSeq / events 末尾 seq」三者最大值，进程被杀、插件重装、手动改 meta 都不会重复写同一条事件。

## 事件瘦身

默认 `slim` 模式：去掉 `assistant/message` 的逐 token 流（占日志七成以上），按 `resultPreview` 截断工具结果，并且不收录 `assistant/attempt`、`llm/retry*`、`request/context`、`image/offload`、`job/*`。实测把一段 4.83 MB 的会话日志压到 1.83 MB，`transcript.md` 仍是完整正文。需要原样全量存，设 `eventLogMode: full`。

## 目录结构

```
会话归档/
├── .index.json      # sessionId → 序号 / 目录名 / 标题 / lastSeq
├── README.md        # 全量索引表，含事件数
├── 001-第一个会话/
│   ├── transcript.md    # 人读的对话记录，按轮次分隔
│   ├── events.jsonl     # 瘦身后的原始事件，一行一条
│   └── meta.json        # 序号 / 标题 / cwd / 路由 / token 用量 / 事件数
└── 002-第二个会话/
```

默认根目录是**会话自己的工作目录**下的 `会话归档/`，用 `baseDir` 可以钉死一个统一位置。

## 配置项

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `baseDir` | 空 | 统一归档根目录；空则用每个会话工作目录下的 `folderName` |
| `folderName` | `会话归档` | `baseDir` 为空时使用的目录名 |
| `includeSubagents` | `false` | 是否也给子代理会话建目录 |
| `keepEventLog` | `true` | 是否写 `events.jsonl` |
| `eventLogMode` | `slim` | `slim` 去流+截断，`full` 原样存 |
| `transcript` | `true` | 是否写 `transcript.md` |
| `adoptExisting` | `false` | 启用插件时是否立刻接管已存在的会话 |
| `maxEventLogBytes` | `8388608` | `events.jsonl` 轮转阈值 |
| `argsPreview` | `240` | 工具调用参数在记录里的最大字符数 |
| `resultPreview` | `1200` | 工具结果在记录里的最大字符数 |

## HTTP 接口（给 Web 端用）

| 路径 | 说明 |
| --- | --- |
| `GET /session-archive/state?session=<id>` | 序号、目录、文件清单与体积、路由、token 用量 |
| `GET /session-archive/reveal?session=<id>` | 在系统文件管理器里打开该会话的归档目录 |

## 命令行

```bash
node tools/archive-cli.mjs list
node tools/archive-cli.mjs show 003
node tools/archive-cli.mjs search 关键词 --context 1
node tools/archive-cli.mjs stats
```

## 限制

- 序号按插件看到会话的顺序分配，不是按会话开始时间。
- 标题由 DSH 标题服务生成，通常聊过一两句才出现，所以文件夹会先叫「未命名会话」再改名。
- `transcript.md` 是追加的可读摘要，精确回放请用 `events.jsonl`。
