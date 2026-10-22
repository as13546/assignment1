# coding agent 工作台

> **这份文档是给人看的。** 它面向要读代码、跑起来、或看演示的人，讲清楚这个
> 项目是什么、怎么跑、每个功能落在哪里。构建状态、改动记录和未完成事项这类
> 内部信息不在这里，而在 `PROGRESS.md` —— 那份是给机器（下一个会话、`git log`
> 或 agent）接着用的工作记录。两份文档请一起维护。

这是哈佛课程 [CS2680 Modern AI Systems: Agents and System Optimizations](https://cs2680.seas.harvard.edu/assignments/)
的 Assignment 1。做一个网页来驱动 Claude Code：你输入请求，服务器在你指定的工作目录里
启动 agent，页面把 agent 的轨迹逐个事件地渲染出来，同时显示它调用了哪些工具、状态如何、
花了多少钱。

除了「实时看一次运行」，它也能当一个 **agent 工作台** 用：授权之后从本机读取 Claude Code
留下的会话记录，左侧点开任意一个就能进入那段对话，看它当时是怎么一问一答、把哪些文件读了
又改了。

## 运行
```bash
cd H:/init_claude/assignment1
bun install
bun run src/server.ts --cwd /path/to/a/repo
```

然后打开 <http://127.0.0.1:5173>。`--cwd` 是 agent 运行时所在的工作目录；不传就用启动服务器时所在的目录。

### 参数

| 参数 | 作用 |
| --- | --- |
| `--cwd <dir>` | agent 的默认工作目录 |
| `--port <n>` | 端口，默认 5173 |
| `--host <addr>` | 地址，默认 127.0.0.1 |
| `--token <secret>` | 要求每个请求都携带这个 token（见下文「对外暴露」） |
| `--claude <path>` | 要启动的 CLI，默认 `claude` |
| `--replay-delay <ms>` | 回放时每个事件之间的间隔，默认 30 |
| `--session-dirs <a,b>` | 「最近会话」扫描的目录，逗号分隔；默认是 `~/.claude/projects` |
| `--no-skip-permissions` | 不传 `--dangerously-skip-permissions` |

## 工作原理

```
                        ┌─ 实时：claude -p "<prompt>" --output-format stream-json
  三种数据源 ──────────┤   fixtures/*.jsonl（录制流）
                        └─ 本机会话：~/.claude/projects/*/*.jsonl
                                 │
                          src/lines.ts        按 BOM 判断编码，逐行切分
                                 │
                          src/runner.ts       分派数据源，产出 RunnerMessage
                                 │
                          src/translate.ts    事件 → 可渲染的节点和 op（唯一的归约器）
                                 │
                          src/drive.ts        判定一次运行的最终状态
                                 │
                          src/server.ts       Bun.serve：HTTP + WebSocket
                                 │
                              public/          页面本身
```

关键在于**只有归约器知道「一个事件意味着什么」**。三种数据源形态完全不同——实时
运行的 stdout、录制流、以及本机会话记录——但都会被 `src/transcript.ts` 或
`src/runner.ts` 改写成同一种事件，再共用同一条下游管线。因此导入的历史对话和
实时运行在页面上是同一套渲染，没有第二套代码。

| 文件 | 职责 |
| `src/runner.ts` | 唯一启动子进程的地方；负责三种数据源的分派（实时 / fixture / 会话记录） |
| `src/lines.ts` | 按 BOM 判断编码的逐行切分（UTF-16LE 的 PowerShell 陷阱在这里处理） |
| `src/transcript.ts` | 读本机的 Claude Code 会话记录，把它改写成归约器认识的事件流 |
| `src/translate.ts` | 归约器 — 唯一知道「一个事件意味着什么」的地方 |
| `src/drive.ts` | 一次运行的生命周期：消息进、op 出、结束时定状态 |
| `src/server.ts` | HTTP、WebSocket、静态文件、鉴权、会话读取的授权开关 |
| `src/types.ts` | 节点、op、原始事件的类型 |
| `public/md.js` | 一个小的 Markdown 渲染器，先转义再输出标签 |
| `public/app.js` | 画节点、应用增量更新、面板切换、会话列表 |
| `tests/` | 84 个测试，含 `tests/helpers/fake-claude.mjs` 走真实 spawn 路径 |
| `scripts/smoke-replay.mjs` | 无头跑一遍真实 WebSocket 的数据通路 |
| `scripts/check-workbench.py` | 端到端检查：授权、对话列表、两个大屏视图 |

服务器会先把每个原始事件归约，**只把结果 op 转发给页面**，所以页面从不整体重渲染轨迹；同时它按 turn 保存运行状态，因此运行中途刷新页面会重建视图而不是丢失轨迹。

## 作业要求的七个功能

| 功能 | 落在哪里 |
| --- | --- |
| 提交提示 | `POST /api/turns`。**页面上的输入框已移除**，现在只能通过接口发起 |
| 实时展示轨迹 | `translate.applyEvent` 为每个事件产出一个 `node` op，`app.placeNode` 追加它 |
| 展示工具结果 | `foldResult` 保留 12 行 / 1200 字符的预览**以及完整原文**，所以折叠可逆、能展开 |
| 状态（每次调用 + 每次运行） | 靠 `tool_use.id` ↔ `tool_result.tool_use_id` 配对；`pending` / `ok` / `error`，以及 `running` / `finished` / `failed` |
| 继续对话 | result 事件里的 `session_id` 作为下一轮的 `--resume` 传回去。**页面上没有入口**，只能通过接口传 `resumeSessionId` |
| 展示运行数据 | result 事件里的 `total_cost_usd`、`duration_ms`、`num_turns`；导入的历史对话没有价格记录，只显示真实耗时与轮次 |
| 轨迹树 | `parent_tool_use_id` 把子 agent 的事件嵌到发起它的调用下面。**outline 侧栏已移除**，树形嵌套仍在轨迹里 |

在必需功能之外还做了：对所有展示文本做一次密钥脱敏、「chatter counter」把纯计数事件折叠起来、长子 agent 运行自动折叠、**授权后读取本机最近会话的对话列表**，以及深链 `/?replay=<fixture>`（打开页面即回放一份录制流）。

> ⚠️ 上表里标粗的三项，后端都实现并测过了，但 2026-10-22 的界面精简把它们的页面入口
> 去掉了（输入框、resume 入口、outline 侧栏）。如果这份作业要按「七个功能在页面上可见」
> 来评分，这三项目前是看不到的——详见 `PROGRESS.md` 的 "Assignment feature status"。

## 页面结构


```
┌──────────────────────────────────────────────────────────────┐
│ 顶栏：chatter / 主题 / 清空 / 连接状态                        │
├───────────┬──────────────────────────────────────────────────┤
│ 对话列表  │ 轨迹：某一次运行的完整过程                       │
│ (本机会话)│ 提示 → 回答 → 工具调用与结果 → 结束数据           │
├───────────┴──────────────────────────────────────────────────┤
└──────────────────────────────────────────────────────────────┘
```

- **对话列表**：默认不读取本机任何文件。点「Allow」后服务器才去扫描 `~/.claude/projects` 下 Claude Code 留下的会话记录（`<项目>/<session-id>.jsonl`），并显示每段对话的时间、轮次、工具调用数、token 数和第一句提问；点「Stop sharing」立即收回权限，之后 `GET /api/sessions` 一律返回 403。
- **成本**：实时运行有 `total_cost_usd`，所以显示美元。导入的历史对话里没有价格记录，因此只显示**真实记录的**耗时与轮次，不做估算。

## 录制流（回放）

`fixtures/` 里是真实的运行记录，这样开发和验证渲染都不用花掉一次运行。用深链 `/?replay=<fixture>`，或：

```bash
bun run scripts/smoke-replay.mjs subagent.jsonl
```

| Fixture | 展示什么 |
| --- | --- |
| `basic.jsonl` | 一次短运行，含一个 Bash 调用及其结果 |
| `subagent.jsonl` | 一个 `Agent` 调用，下面嵌着 12 个工具调用 |
| `failure.jsonl` | 一次失败的运行，带 CLI 自己的报错信息 |
| `powershell-utf16.jsonl` | 用 PowerShell 保存的运行，即 **UTF-16LE** |

回放是开发用的便利手段，被限制为只能读 `fixtures/` 目录内的文件。它**不能替代真实运行**：它演示不了「事件边到边陆续到达」，它里面的 session id 也不能真的 resume。



