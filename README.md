#  coding agent 工作台

> **这份文档是给人看的。** 它面向要读代码、跑起来、或看演示的人，讲清楚这个
> 项目是什么、怎么跑、每个功能落在哪里。构建状态、改动记录和未完成事项这类
> 内部信息不在这里，而在 `PROGRESS.md` —— 那份是给机器（下一个会话、`git log`
> 或 agent）接着用的工作记录。两份文档请一起维护。

以下是对项目的介绍
这是一个展示claudecode的工作原理的网页，作用是用来驱动 Claude Code 并实时展示它正在做什么。当你输入请求时，服务器就会在你指定的工作目录里启动 agent，而这个页面将会对逐个事件地渲染agent的轨迹。这是哈佛的最新Agent的课程CS2680 Modern AI Systems: Agents and System Optimizations，链接是https://cs2680.seas.harvard.edu/assignments/

它也可以当作一个 **agent 工作台** 来用：左侧是「对话列表」，在你授权之后读取本机 Claude Code 留下的会话记录，点开任意一个就能进入该对话；中间是调用纲要；右侧大屏承载与 agent 的交互过程和完整工作流图，一眼看清它调用了哪些工具、状态如何、花了多长时间。

## 运行



```bash

cd H:/init_claude/assignment1
bun install
bun run src/server.ts --cwd /path/to/a/repo
```

然后打开 <http://127.0.0.1:5173>。`--cwd` 是 agent 的工作目录，也是页面上「working directory」输入框的默认值；不传就用启动服务器时所在的目录。


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
claude -p "<prompt>" --output-format stream-json --verbose
        │
        ├─ src/runner.ts     启动它，把 stdout 切成一条条事件
        ├─ src/translate.ts  把事件变成可直接渲染的节点和 op
        ├─ src/drive.ts      判定一次运行的最终状态
        ├─ src/server.ts     Bun.serve：HTTP + WebSocket
        └─ public/           页面本身
```

| 文件 | 职责 |
| --- | --- |
| `src/runner.ts` | 唯一碰子进程和 fixture 文件的地方；也负责三种数据源的分派（实时 / fixture / 会话记录） |
| `src/lines.ts` | 按 BOM 判断编码的逐行切分（UTF-16LE 的 PowerShell 陷阱在这里处理） |
| `src/transcript.ts` | 读本机的 Claude Code 会话记录，把它改写成归约器认识的事件流 |
| `src/translate.ts` | 归约器 — 唯一知道「一个事件意味着什么」的地方 |
| `src/drive.ts` | 一次运行的生命周期：消息进、op 出、结束时定状态 |
| `src/server.ts` | HTTP、WebSocket、静态文件、鉴权 |
| `public/md.js` | 一个小的 Markdown 渲染器，先转义再输出标签 |
| `public/app.js` | 画节点、应用增量更新 |
| `public/workflow.js` | 把一次运行画成竖向流程图（提交 → 工具调用与结果 → 结束数据） |

服务器会先把每个原始事件归约，**只把结果 op 转发给页面**，所以页面从不整体重渲染轨迹；同时它按 turn 保存运行状态，因此运行中途刷新页面会重建视图而不是丢失轨迹。

## 作业要求的七个功能

| 功能 | 落在哪里 |
| --- | --- |
| 提交提示 | `index.html` 的输入区；`POST /api/turns` |
| 实时展示轨迹 | `translate.applyEvent` 为每个事件产出一个 `node` op，`app.placeNode` 追加它 |
| 展示工具结果 | `foldResult` 保留 12 行 / 1200 字符的预览**以及完整原文**，所以折叠可逆、能展开 |
| 状态（每次调用 + 每次运行） | 靠 `tool_use.id` ↔ `tool_result.tool_use_id` 配对；`pending` / `ok` / `error`，以及 `running` / `finished` / `failed` |
| 继续对话 | result 事件里的 `session_id` 作为下一轮的 `--resume` 传回去 |
| 展示运行数据 | result 事件里的 `total_cost_usd`、`duration_ms`、`num_turns` |
| 轨迹树 | `parent_tool_use_id` 把子 agent 的事件嵌到发起它的调用下面；outline 栏与对话并排，窗口小于 1280px 时收起 |

在必需功能之外还做了：停止按钮、对所有展示文本做一次密钥脱敏、「chatter counter」把纯计数事件折叠起来、outline 点击跳转、长子 agent 运行自动折叠、**授权后读取本机最近会话的对话列表**、**把整次运行画成流程图的 Workflow 视图**，以及深链 `/?replay=<fixture>`（打开页面即回放一份录制流）。

## 页面结构

```
┌──────────────────────────────────────────────────────────────┐
│ 顶栏：工作目录 / chatter / 主题 / 连接状态                    │
├───────────┬──────────┬───────────────────────────────────────┤
│ 对话列表  │ 纲要     │ 大屏：Conversation │ Workflow         │
│ (本机会话)│ (调用名) │ 交互过程 / 全生命周期流程图            │
├───────────┴──────────┴───────────────────────────────────────┤
│ 输入框：提交提示、继续对话、停止                              │
└──────────────────────────────────────────────────────────────┘
```

- **对话列表**：默认不读取本机任何文件。点「Allow」后服务器才去扫描 `~/.claude/projects` 下Claude Code 留下的会话记录（`<项目>/<session-id>.jsonl`），并显示每段对话的时间、轮次、工具调用数、token 数和第一句提问；点「Stop sharing」立即收回权限，之后 `GET /api/sessions` 一律返回 403。
- **成本**：实时运行有 `total_cost_usd`，所以显示美元。导入的历史对话里没有价格记录，因此只显示**真实记录的**耗时与轮次，不做估算。
- **Workflow 视图**：与大屏等宽的生命周期流程图，顶部状态条常驻显示 `状态 · 成本 · 耗时 · 回合数 · 调用数`。



## 录制流（回放）

`fixtures/` 里是真实的运行记录，这样开发和验证渲染都不用花掉一次运行。用页面底部的 dev 面板，或：
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
回放是开发用的便利手段，被限制为只能读 `fixtures/` 目录内的文件。它**不能替代真实运行**：它演示不了「事件边到边陆续到达」，它里面的 session id 也不能真的 resume。

## 对外暴露

这个页面本质上是「一个能读文件、能跑命令的进程」的远程控制器，所以默认只绑 `127.0.0.1`。如果要从别的机器访问，请用 `--token $(openssl rand -hex 16)` 并把 token 排除在仓库之外；任何不带 token 的请求都会收到 401。另外，把 agent 指向一个临时目录而不是你的家目录——**页面会把它读到的一切都展示出来**（演示视频和截图也一样）。

服务器默认会传 `--dangerously-skip-permissions`，这只对临时目录是安全的选择。其他情况下请用 `--no-skip-permissions` 启动。
