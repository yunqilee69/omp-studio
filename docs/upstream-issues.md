# 上游缺口（omp 18.1.2）与降级方案

本文记录 OMP Studio 需要、但 `omp --mode rpc-ui` 当前**没有**的 RPC，附取证方式与仓库内的临时做法。
产品侧结论见 [`dev-plan.md` §3.2](dev-plan.md)；本文是证据与验收依据，不是需求。

取证环境：样本主要录自 `omp 18.1.2`（`/home/linuxbrew/.linuxbrew/bin/omp`）；
U2 另在 darwin arm64 的 `omp 18.0.11` 与 `18.2.8`（`/opt/homebrew/bin/omp`）复核过，并新增 `--plan-yolo` 全程录制；
U4 的取证在 darwin arm64 `omp 18.2.8` 上完成（`ask` 工具 18.2.8 起注册进 rpc-ui）。
样本在 [`rpc-samples/`](rpc-samples)（含 `ask.jsonl` / `approval.jsonl`），采集脚本 `extension/scripts/probe-rpc.mjs`（`--steps ask --mode rpc-ui`）。

## 0. 权威命令清单（先对齐事实）

从 omp 18.1.2 二进制的 RPC 分发表（`case "<command>"`）逐条抽出，共 42 条：

```text
negotiate_protocol  prompt  steer  follow_up  abort  abort_and_prompt  new_session
switch_session  branch  get_state  set_fast_mode  get_available_commands  set_todos
set_host_tools  set_host_uri_schemes  set_subagent_subscription  get_subagents
get_subagent_messages  set_model  cycle_model  get_available_models  set_thinking_level
cycle_thinking_level  set_steering_mode  set_follow_up_mode  set_interrupt_mode  compact
set_auto_compaction  set_auto_retry  abort_retry  bash  abort_bash  get_session_stats
export_html  get_branch_messages  get_last_assistant_text  set_session_name  handoff
get_messages  get_messages_page  get_login_providers  login
```

复现：

```bash
node -e 'const s=require("fs").readFileSync(process.argv[1],"utf8");const i=s.indexOf(`case "get_state"`);console.log([...s.slice(i-6000,i+12000).matchAll(/case "([a-z_]+)":/g)].map(m=>m[1]).join("\n"))' /home/linuxbrew/.linuxbrew/bin/omp
```

这也解释了 `get_state` 的字段面：`model, thinkingLevel, isStreaming, isCompacting, steeringMode,
followUpMode, interruptMode, sessionFile, sessionId, sessionName, autoCompactionEnabled,
queuedMessageCount, todoPhases, fastModeEnabled, tokensPerSecond, fastModeActive, messageCount,
systemPrompt, dumpTools, contextUsage`（与 `rpc-samples/basic.jsonl` 实测一致）。

## U1 — 没有 `list_sessions`

**缺口**：无法枚举历史会话。

**证据**：上面 42 条里没有 `list_sessions`；`get_state` 只返回**当前** `sessionFile`/`sessionId`；
`get_messages_page` 只分页当前会话。历史列表在 RPC 面上不存在。

**降级（已实现）**：`extension/src/session-picker.ts` 直接扫
`<agentDir>/sessions/<encoded-cwd>/*.jsonl`，其中 `agentDir = $PI_CODING_AGENT_DIR ?? <configRoot>/agent`
（默认 `~/.omp/agent`，`configRoot = $PI_CONFIG_DIR ?? .omp`，再叠加 `$OMP_PROFILE`）。
bucket 名 = 去掉 home 前缀、`/` 换成 `-`。

已核对的真实形状：

```text
/home/yunqi/cloudomni/omp-studio  ->  -cloudomni-omp-studio
/tmp                              ->  -tmp
/tmp/omp probe-with.dot_and-under ->  -tmp-omp probe-with.dot_and-under
```

**风险**：`encoded-cwd` 规则与标题槽位（`{"type":"title"}` / 首条 user 文本）都由 omp 单方面定义，
升级 omp 后可能漂移。所以只在**当前工作区 bucket** 内降级，不扫全盘。

**上游补上后要做的**：删掉目录扫描，改走 `list_sessions`；不要长期双轨。

## U2 — 没有 `mode` 读写

**缺口**：`get_state` 不返回模式，也没有 `set_mode`；进程起来后在 RPC 里改不了模式。

**证据**（本机 `omp 18.0.11`、最新发布 `18.2.8`、上游 `main` 源码三处都查过）：

1. 42 条命令里没有 `set_mode` / `get_mode`；`get_state` 的构造对象里也没有 `mode` 字段
   （`rpc-samples/basic.jsonl`、`plan-yolo.jsonl` 里 `get_state` 实测 `mode: undefined`）。
2. 未知命令落到默认分支 `errorResponse(undefined, …)`——**连 id 一起丢**，所以 `set_mode` 就算发出去
   也永远配不上响应，客户端只能硬等超时。所以本插件不做「探测式」的药丸：发一个自己不认识的命令、
   再把猜的结果画成状态，就是在撒谎。
3. `prompt("/plan")` **不是**模式开关：`rpc-samples/plan.jsonl` 里 `/plan` 被当普通用户输入，
   模型据此去读 skill 与既有计划，全程没有 `mode_change` 条目。
4. 会话 jsonl 的 `mode_change` 条目是模式的历史记录，也是插件显示模式的兜底来源：

```json
{"type":"mode_change","id":"faa8be06","parentId":"3c33f92e","timestamp":"2026-09-11T01:21:31.429Z","mode":"vibe","data":{"previousTools":["read","bash","edit"]}}
{"type":"mode_change","id":"9fdb7bff","parentId":"faa8be06","timestamp":"2026-09-11T01:21:35.316Z","mode":"none"}
```

   实测出现过的值：`plan`、`none`、`vibe`；omp 源码里另有 `plan_paused`、`goal`。
   `data.planFilePath`（如 `local://PLAN.md`）也只在这个条目上出现，是计划视图正文的第一来源。
5. **`--plan-yolo` 不写 `mode_change`**：`rpc-samples/plan-yolo.jsonl` 走完一整轮，会话文件里没有该条目，
   把握不到「计划已批准、开始实施」这个转折，除非去认 omp 自己发的那条 notice（下面第 4 步）。

**真能走的路：`--plan-yolo`**（omp 自己的 headless 规划流程）

```bash
omp --mode rpc --cwd <ws> --plan-yolo [--plan-yolo-into <model|@role>]
```

`--plan-yolo-into` 默认 `@smol`；只给 `--plan-yolo-into` 不给 `--plan-yolo` 会直接报错。
[`rpc-samples/plan-yolo.jsonl`](rpc-samples/plan-yolo.jsonl) 是真机录制（协议见该文件里的 `ready`/`response` 帧），
一轮里依次是：

1. **只读起草**：`tool_execution_start` 只有 `read` / `glob`，工作区文件一个都没动；
2. `write local://<slug>-plan.md`：计划正文；
3. `write xd://propose`：提案，工具结果文本是 `Plan approved. Implementing now with deepseek.`；
4. `notice { source: "plan-yolo", level: "info", message: "Plan-yolo: plan approved, switched to OmniGate/deepseek …" }`
   —— **pill 从 Plan 回到 Agent 的唯一依据**（`src/mode.ts` 的 `isPlanHandoff`）；
5. 之后才出现落在工作区的 `edit`（`probe-notes.txt` 第 2 行 `beta` → `BETA`），同一轮 `agent_end`。

**降级（已实现）**：

- `extension/src/mode.ts`：菜单与判定是纯函数——`modeChoices` / `modeNote` / `modeRefusal` /
  `isPlanHandoff`。文案归宿主：`modeNote` 随 HostMessage 下发，webview 只画行。
  `get_state.mode` 一旦出现，`surface.rpc` 为真，四个模式原地全开，同一份 UI 不换。
- `extension/src/instance.ts`：`--plan-yolo` 由 spawn 参数带（新会话），或由 `modeSurface` /
  `canRestartProcess()` 决定能否换进程；模式名优先级 = `get_state.mode` > `--plan-yolo` 启动态 >
  会话文件 `mode_change`，**永不本地乐观**。`setMode` 在 RPC 无 mode 时直接返回 `false`，不挂起。
- `InstanceManager.setMode`：先试原地 `set_mode`；Plan 与「回 Agent」走 `restartAs`——在同一个 Tab id 下
  换掉进程并 `--resume` 同一份 jsonl（新进程先认领 Tab，旧进程随后 drain；jsonl 全程仍归这个 Tab，
  AGENTS.md 的「一个 jsonl 只给一个进程」不变），标题与历史跟 jsonl 走；
  Goal/Vibe 用 `modeRefusal` 原样说出拒绝原因。会话列表页选 Plan 直接用 spawn 参数，不经重启。

**上游补上后要做的**：删掉 `--plan-yolo` 重启分支与 `modeNote` 里的 U2 文案，改走 `set_mode` 原地切；
`isPlanHandoff` 连同 notice 特判一起删（模式由 RPC 报告，不再靠 notice 认阶段）。

## U3 — 没有 MCP 读写

**缺口**：没有 `get_mcp_servers` / `set_mcp_enabled` / `reload_mcp`。

**证据**：42 条命令里没有任何 mcp 命令。MCP 只能走 slash：`prompt("/mcp list")`
返回一个 `command_output` 文本帧 + `prompt` 响应（`data.agentInvoked=false`，不产生 agent 轮次）。
原始输出见 [`rpc-samples/mcp.txt`](rpc-samples/mcp.txt)：

```text
filesystem | stdio | enabled | npx [project]
disabled-one | stdio | enabled | echo [project]
```

`/mcp` 帮助文本声明 `add/remove/enable/disable/reload/resources/prompts/test/smithery-search`，
即**只能**用自然语言形状的命令文本驱动，且 `list` 输出是给人看的表格，不是机读 JSON。

**降级（已实现）**：

- 读：`extension/src/mcp.ts` 直接读 omp 读的那两个文件
  （用户 `<agentDir>/mcp.json`、项目 `<cwd>/.omp/mcp.json`），规则与运行期加载器一致：
  项目条目覆盖同名用户条目；用户文件 `disabledServers` 里的名字算禁用；`enabled:false` 也算禁用。
- 写：`InstanceManager.toggleMcp()` 发 `prompt("/mcp enable|disable <name>")`，
  让 omp 自己改写它认的那个文件——插件永不写 mcp.json，避免两个写入者互相覆盖。
- 时效：进程启动时已加载的 server 不会变，面板在提示里明说「重开 Tab 后生效」。

**上游补上后要做的**：改走 `get_mcp_servers` / `set_mcp_enabled` / `reload_mcp`，删掉文件解析。

## 其他已核对、但**不是**缺口的点

| 观察 | 处理 |
|---|---|
| `switch_session` / `branch` / `new_session` 存在 | 本产品不用：一个 Tab 一个进程一份 jsonl，`--resume` 才打开历史（AGENTS.md 锁定决策）。 |
| `get_subagents` 只给注册表（`rpc-samples/subagents.json`） | 子智能体正文走 `agent://` 产物目录，见 `extension/src/artifacts.ts`。 |
| `extension_ui_request` 的 `editor` 带 `prefill`、`notify` 带 `notifyType` | 已按实测字段解析（`src/rpc/types.ts`），另处理 omp 主动发的 `{"method":"cancel","targetId"}`。 |
| `advisor_cost_changed` 帧无字段 | 认识但不着色渲染，只保证不被当成未知帧。 |

## U4 — `ask`（交互选择题）的 RPC 出口不全

**U4-1 缺口**：`omp --mode rpc` 不注册 `ask` 工具，交互请求只有 `--mode rpc-ui` 才发。

**证据**（darwin arm64，`omp 18.2.8`，`/opt/homebrew/bin/omp`）：

```bash
node scripts/probe-rpc.mjs docs/rpc-samples --steps ask --cwd /tmp/ask-probe-ws
# rpc 模式：get_available_commands 无 ask，模型只能口头列选项（无 extension_ui_request）
# rpc-ui 模式：ask 注册（12 工具），select/input/editor/confirm 请求全量出现
```

宿主源码里开关是 `E.hasUI = f || r === "rpc-ui"`：`ask` 只在 `hasUI` 时进工具表。
`docs/rpc-samples/ask.jsonl`（rpc-ui，4 场景：单选+描述+推荐、多选三轮、双问题、Other→editor）
与 `approval.jsonl`（confirm 多行标题）是形状基线。

**降级（已实现）**：无缺口——直接切 `--mode rpc-ui`（`src/rpc/process.ts`）。
rpc 与 rpc-ui 的其余帧形状一致（probe 全量对比过），不构成第二套协议。

**U4-2 缺口**：多选嵌多问题时，`(n/m)` 序列的左右导航没有 RPC 出口。

**证据**：omp 的 TUI 里 `select` 支持 `←/→` 回到上一题；RPC 的 `extension_ui_response`
只有 `{id, value|confirmed|cancelled}`，没有导航字段——`requestRpcSelect` 拿到的帧里
导航事件被 omp 自身丢弃，插件无从重放。18.2.8 实录 `ask.jsonl` 的双问题场景里，
第二题的 select 帧只带 `progress`，没有任何可回退的字段。

**降级（已实现）**：webview 只渲染 `progress` 徽标（`1/2`），不做回退按钮；
用户要改前面题的答案只能取消（Esc → `cancelled`）重来。

**上游补上后要做的**：`extension_ui_response` 增加 target/导航语义后，
面板补 `←` 按钮与键盘 `←/→`。
