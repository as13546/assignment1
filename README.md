# Assignment 1 — 一个观察 coding agent 工作过程的页面
这是哈佛的最新Agent的课程CS2680 Modern AI Systems: Agents and System Optimizations，链接是https://cs2680.seas.harvard.edu/assignments/


以下是对项目的介绍
这是一个展示claudecode的工作网页，用来驱动 Claude Code 并实时展示它正在做什么。当你输入请求时，服务器就会在你指定的工作目录里启动 agent，而这个页面将会对逐个事件地渲染agent的轨迹。

## 运行

需要 [Bun](https://bun.sh)，以及一个已登录的 `claude` CLI。**没有 `npm install` 这一步**：服务器用的是 Bun 内置的 HTTP 和 WebSocket，页面本身零依赖。

```bash
bun install                     # 只装 @types/bun，给类型检查用
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
| `src/runner.ts` | 唯一碰子进程和 fixture 文件的地方 |
| `src/translate.ts` | 归约器 — 唯一知道「一个事件意味着什么」的地方 |
| `src/drive.ts` | 一次运行的生命周期：消息进、op 出、结束时定状态 |
| `src/server.ts` | HTTP、WebSocket、静态文件、鉴权 |
| `public/md.js` | 一个小的 Markdown 渲染器，先转义再输出标签 |
| `public/app.js` | 画节点、应用增量更新 |

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
| 轨迹树 | `parent_tool_use_id` 把子 agent 的事件嵌到发起它的调用下面；outline 侧栏与对话并排，窗口小于 1024px 时收起 |

在必需功能之外还做了：停止按钮、对所有展示文本做一次密钥脱敏、「chatter counter」把纯计数事件折叠起来、outline 点击跳转、长子 agent 运行自动折叠，以及深链 `/?replay=<fixture>`（打开页面即回放一份录制流）。



## 录制流（回放）

`fixtures/` 里是真实的运行记录，这样开发和验证渲染都不用花掉一次运行。用页面底部的 dev 面板，或：

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

## 对外暴露

这个页面本质上是「一个能读文件、能跑命令的进程」的远程控制器，所以默认只绑 `127.0.0.1`。如果要从别的机器访问，请用 `--token $(openssl rand -hex 16)` 并把 token 排除在仓库之外；任何不带 token 的请求都会收到 401。另外，把 agent 指向一个临时目录而不是你的家目录——**页面会把它读到的一切都展示出来**（演示视频和截图也一样）。

服务器默认会传 `--dangerously-skip-permissions`，这只对临时目录是安全的选择。其他情况下请用 `--no-skip-permissions` 启动。
