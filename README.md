[中文](README.md) | [English](README.en.md)

# 会话归档（session-archive）

每个 DSH 会话自动获得一个**带序号的文件夹**；会话标题一变，文件夹跟着改名，序号保持不变。附带 Web 端胶囊和命令行工具。

## 一次会话产出什么

```
会话归档/
├── .index.json              # sessionId → { seq, folder, title, lastSeq }，原子写（tmp+rename）
├── .gitignore               # 落在 git 仓库里时不污染工作树
├── README.md                # 全量索引表，按序号排
├── 001-整理默认工作区存储目录下的/
│   ├── transcript.md        # 人读的对话记录（用户 / 助手 / 工具调用 / 轮次分隔）
│   ├── events.jsonl         # 瘦身后的原始事件，一行一条，可直接喂给 jq
│   ├── events.1.jsonl       # 超过 8 MB 后轮转出来的历史分片
│   └── meta.json            # 序号、标题、cwd、模型、token 用量、事件数
└── 002-下一个会话/
```

## 行为

| 时机 | 动作 |
| --- | --- |
| `session/created` | 建 `<seq>-未命名会话/`，序号取自 `.index.json` 的 `nextSeq`，三位补零 |
| `session/event` | 增量追加到 `transcript.md` 与 `events.jsonl`，不重扫日志、不重写文件 |
| `session/title` | 防抖 300 ms 后目录原地 `rename` 成 `<seq>-<标题>`；非法字符换空格，超长截到 40 字 |
| `session/disposed` | 补做最后一次改名与 meta 落盘 |
| 事件密集 | meta 每 20 条落一次盘，README 索引表 2 s 节流；两者都是崩溃后能接上的断点 |

### 断点续写（不重复）

会话被恢复或插件重装后，续写起点取三者最大值：索引里的 `lastSeq`、`meta.json` 里的 `lastSeq`、`events*.jsonl` 末尾那条事件的 `seq`。因此进程被杀、插件重启、手动改 meta 都不会把同一条事件写两遍；本生命周期内还有 `lastWritten` 兜底。

### 事件瘦身（默认开）

`assistant/message` 的逐 token 流（`stream`）能占日志七成以上，`slim` 模式会去掉它；`tool/result` 按 `resultPreview` 截断；`assistant/attempt`、`llm/retry*`、`request/context`、`image/offload`、`job/*` 这些对复盘无用的记录直接不入库。实测当前会话日志从 4.83 MB 降到 1.83 MB（省 62%），`transcript.md` 仍是完整正文。要原始全量就设 `eventLogMode: full`。

## Web 端

输入框下方多一个 `003 · 归档` 胶囊，点开是面板：目录路径、文件清单与体积、`打开目录` / `复制路径` / `刷新`。

| 接口 | 说明 |
| --- | --- |
| `GET /session-archive/state?session=<id>` | 序号、目录、文件清单、路由、token 用量 |
| `GET /session-archive/reveal?session=<id>` | 在系统文件管理器里打开该会话目录 |

## 命令行

```bash
node tools/archive-cli.mjs list                    # 全部会话
node tools/archive-cli.mjs show 003                # 单个会话的目录/文件/用量
node tools/archive-cli.mjs search 归档 --context 1  # 全文搜 transcript
node tools/archive-cli.mjs stats                   # 体积与 token 汇总
```

公共参数：`--base <目录>`（默认 `./会话归档` 或 `$DSH_SESSION_ARCHIVE`）、`--json`、`--limit`、`--context`。

## 配置

```yaml
- name: '@local/session-archive'
  config:
    baseDir: ''                      # 钉死统一归档根；空 = 每个会话工作目录下的 folderName
    folderName: 会话归档
    includeSubagents: false
    keepEventLog: true
    eventLogMode: slim               # slim | full
    transcript: true
    adoptExisting: false             # 启用时是否立刻接管已存在的会话
    maxEventLogBytes: 8388608
    argsPreview: 240                 # 工具参数在记录里的截断长度
    resultPreview: 1200              # 工具结果在记录里的截断长度
```

## 已知限制

- 序号按**插件看到会话的顺序**分配，不是按会话开始时间；`adoptExisting: false` 时，历史会话要等下一次活动才建目录。
- 会话标题可能聊了几句才出现，所以文件夹会先叫「未命名会话」再改名——预期行为。
- `transcript.md` 是追加写的纯文本摘要，要精确回放请用 `events.jsonl`。
- 目录被手工删掉后，下一条事件到来时会按索引里的旧名字重建，序号不变。
