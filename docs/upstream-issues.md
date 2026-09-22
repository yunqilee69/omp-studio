# 上游缺口（omp 18.1.2）与降级方案

本文记录 OMP Studio 需要、但 `omp --mode rpc` 当前**没有**的 RPC，附取证方式与仓库内的临时做法。
产品侧结论见 [`dev-plan.md` §3.2](dev-plan.md)；本文是证据与验收依据，不是需求。

取证环境：`omp 18.1.2`（`/home/linuxbrew/.linuxbrew/bin/omp`），
录制样本在 [`rpc-samples/`](rpc-samples)，采集脚本 `extension/scripts/probe-rpc.mjs`。

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

**缺口**：`get_state` 不返回模式，也没有 `set_mode`。

**证据**：

1. 42 条命令中没有 `set_mode` / `get_mode`；`get_state` 的构造对象里也没有 `mode` 字段。
2. 唯一可信来源是会话 jsonl 的 `mode_change` 条目：

```json
{"type":"mode_change","id":"faa8be06","parentId":"3c33f92e","timestamp":"2026-09-11T01:21:31.429Z","mode":"vibe","data":{"previousTools":["read","bash","edit"]}}
{"type":"mode_change","id":"9fdb7bff","parentId":"faa8be06","timestamp":"2026-09-11T01:21:35.316Z","mode":"none"}
```

   实测出现过的值：`plan`、`none`、`vibe`；omp 源码里另有 `plan_paused`、`goal`。
   `data.planFilePath`（如 `local://PLAN.md`）也只在这个条目上出现，是计划视图正文的第一来源。
3. `prompt("/plan")` **不是**模式开关：`rpc-samples/plan.jsonl` 里 `/plan` 被当成普通用户输入，
   模型据此去读 skill 与既有计划，全程没有产生 `mode_change` 条目。

**降级（已实现）**：

- `extension/src/session-file.ts` 解析 `mode_change` → 标题栏显示真实模式；
- `extension/src/instance.ts` 的 `modeNote` 明确写出「只能在 omp 终端里切换」，
  不提供 `mode/set` 消息，也不做乐观本地状态（那是会撒谎的第二份状态）。

**上游补上后要做的**：`get_state.mode` + `set_mode`，删掉 `modeNote` 与会话文件探测。

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
