# OMP Studio 开发计划

VS Code 侧栏控制面。把本机 `omp` 接到编辑器：多实例并发、模式切换、模型切换、MCP 浏览、子智能体/计划只读查看。

本文是产品与阶段的唯一源。实现约束见根目录 `AGENTS.md`。

---

## 0. 结论

做 **OMP 宿主插件**，不做第二套 agent。

| 决策 | 选择 |
|---|---|
| 集成 | `omp --mode rpc` 子进程。不嵌 SDK，不以 ACP 为主路径 |
| 会话 | 每个侧栏 Tab = 一个 RPC 进程 = 一份 jsonl。切 Tab 不断进程 |
| 不做 | `/tree`、`/branch`、同文件多叶、接管子智能体 |
| 子智能体 / 计划 | 当前 Tab 视图栈：整页替换对话，顶上返回 |
| 模式 | `none \| plan \| goal \| vibe`，与模型正交 |
| 配置 | MCP/模型 v1 只浏览和切换，不写完整编辑器 |
| 与终端 | 不 attach 正在跑的 `omp` |

v1 可发布条件：两个 Tab 同时跑完一轮；模式可切；子智能体/计划能进能返回；工具审批不卡死。

---

## 1. 产品

### 1.1 给谁用

已经在用 `omp` 的人。VS Code 写代码，侧栏指挥同一套 `~/.omp`（模型、密钥、MCP、agent 定义、session jsonl）。

不给：没装 `omp` 的人、想要 Cursor 补全/inline edit 的人、想在 VS Code 里换 Claude/Codex 运行时的人（那是 ACP 客户端）。

### 1.2 侧栏结构

```
┌─────────────────────────────────────────────┐
│ [修登录 ●] [重构 ●] [鉴权]              [+] │  Tab = 实例
├─────────────────────────────────────────────┤
│ [Normal|Plan|Goal|Vibe]   [模型 ▾]  [⚙ MCP] │  属于当前 Tab
├─────────────────────────────────────────────┤
│                                             │
│  视图栈（同一区域，同时只显示一层）           │
│                                             │
│  栈底：对话列表 + 输入框                     │
│  push：子智能体输出 / 计划正文（只读）        │
│  ← 返回 = pop                               │
│                                             │
└─────────────────────────────────────────────┘
```

Activity Bar 一个图标，一个 `WebviewView`。不要编辑区大聊天窗（v1），不要左右分栏。

### 1.3 会话 = 并发实例

用户要的是「两个开发任务同时跑」，不是一条对话的树分叉。

| 操作 | 行为 |
|---|---|
| `+` | 新 `omp --mode rpc`，cwd = 工作区根，新 jsonl，新 Tab |
| 点 Tab | 只换可见 transcript / 事件源。其它进程继续 |
| 关 Tab | 停该进程。流式或有未完成工具调用时确认 |
| 打开历史 | picker 选当前工作区 jsonl → **新 Tab + 新进程 `--resume <path>`** |
| 同文件 | 已打开的 jsonl 禁止再开。picker 标「已在 Tab」 |

不做：`switch_session` 复用进程（切走会 abort，违反并发）；会话树；把子 agent jsonl 当 Tab。

软上限 **4** 个运行中实例。超出提示费用/CPU。关 VS Code 窗口停掉全部子进程。

### 1.4 视图栈

每个 Tab 自己一条短栈。默认 `[对话]`。

- 对话里的 `task` 卡片 →「查看输出」→ push `[子智能体: <id>]`
- Plan 产出计划 →「查看计划」→ push `[计划]`
- Goal 若有目标摘要 → 同样 push `[目标]`
- 顶栏 `← 返回` = pop。无输入框（只读层）
- 切 Tab 保留各 Tab 自己的栈

只读层禁止：发消息、`hub send`、revive/steer/kill、把子 agent 提升为主会话。

### 1.5 模式

挂在当前 Tab 的进程上，不跟视图层走。看子智能体时模式条禁用或收起，返回后恢复。

| UI | OMP | 主会话 |
|---|---|---|
| Normal | `none` | 日常批平：读写、命令、派子 agent |
| Plan | `plan` | 只读规划；批准后才执行 |
| Goal | `goal` | 盯目标推进 |
| Vibe | `vibe` | 导演；worker 干活。与 plan/goal（含暂停）互斥 |

约束做进 UI：

- Plan/Goal 下点 Vibe → 先提示退出
- Vibe 期间禁用 fork/handoff（OMP 会拒）；本产品本就没有 fork
- 切模式只影响当前 Tab
- 计划批准后 OMP 可能按标题自动命名 → Tab 标题刷新

`set_fast_mode` / steering 不是这四个模式，不进分段控件。

### 1.6 模型与 MCP（v1）

**模型**：`get_available_models` + `set_model` + thinking。Quick pick。只列有凭证的。角色（smol/slow/plan）后做。

**MCP**：列表（名称、来源、启用）。开关。点条目打开 `.omp/mcp.json` 或用户 `mcp.json`。不做 OAuth 向导、stdio 表单。

### 1.7 明确不做（v1 及以后默认不做，除非改本文）

- Cursor/Cline：补全、inline edit、自研索引
- 嵌 `@oh-my-pi/pi-coding-agent`
- ACP 主路径
- `/tree` `/branch` `/fork` 作为产品功能
- Agent Hub 接管（steer/revive/kill）
- `models.yml` 可视化编辑器
- MCP 完整 CRUD + OAuth
- 多工作区根、远程 SSH 特殊协议（随 VS Code remote 自然工作即可，不单开）
- 与终端正在跑的 `omp` 抢同一 jsonl

---

## 2. 架构

```
┌─ VS Code extension host ─────────────────────────────────┐
│  activate()                                              │
│    ├─ InstanceManager     Tab id → Instance              │
│    ├─ SessionPicker       读 list_sessions / 降级扫描     │
│    ├─ McpController       列表 + 开关（RPC 或文件）       │
│    └─ SidebarProvider     WebviewView                    │
│                                                          │
│  Instance                                                │
│    ├─ RpcProcess          spawn omp --mode rpc           │
│    ├─ RpcClient           JSONL v2                       │
│    ├─ Transcript          消息 + 工具卡片状态             │
│    └─ ViewStack           chat | subagent | plan | goal  │
└──────────────────────────────┬───────────────────────────┘
                               │ stdio JSONL
                               ▼
                    omp --mode rpc  (cwd = workspace)
                               │
                               ▼
                    ~/.omp/agent/sessions/<encoded-cwd>/...
```

### 2.1 进程合同

启动新实例：

```bash
omp --mode rpc --cwd <workspaceRoot>
```

打开历史：

```bash
omp --mode rpc --cwd <workspaceRoot> --resume <absolute-jsonl>
```

- `PATH` 解析 `omp`；设置项可覆盖绝对路径
- 找不到 → 侧栏说明安装方式，不崩
- stdin 关闭 = 进程退出。关 Tab = kill 进程组（Unix `process.kill(-pid)` 或 `detached` 后明确杀子树）
- 工作区文件夹变更：已有 Tab 仍绑原 cwd；新 Tab 用新根。多根工作区 v1 用 `workspaceFolders[0]`

环境：继承 VS Code 进程 env，以便 `ANTHROPIC_API_KEY` 等与终端一致。不要自己再读一份 `.env`。

### 2.2 一个 Instance 的状态机

```
spawning → ready → idle ⇄ streaming
                ↘ failed
close Tab → disposing → gone
```

- `ready`：收到 `{type:"ready"}`，已 `negotiate_protocol: 2`，已 `get_state`
- `streaming`：`agent_start` 之后、终端 `agent_end`（`isTerminal !== false`）之前
- 进程非 0 退出 → `failed`，Tab 可关可重开（重开 = 新进程 resume 同一 jsonl，若文件已落盘）

### 2.3 消息协议（host ↔ webview）

单文件 `src/shared/protocol.ts`。方向：

**Host → Webview**

- `instance/list` 全部 Tab 摘要（id、title、running、mode、unread）
- `instance/active` 当前 Tab id
- `transcript/replace` 当前视图的消息快照
- `transcript/delta` 流式增量
- `view/push` `{ kind: "subagent"|"plan"|"goal", title, body }`
- `view/pop`
- `ui/request` 审批/confirm/select/input（对应 `extension_ui_request`）
- `models/list` `mcp/list` `state`（mode、model、thinking、contextUsage）

**Webview → Host**

- `tab/new` `tab/select` `tab/close` `tab/open-history`
- `prompt/send` `prompt/abort` `prompt/steer`
- `mode/set` `model/set` `thinking/cycle`
- `view/open-subagent` `{ id }` `view/open-plan` `view/back`
- `ui/respond`
- `mcp/toggle`

webview 不直接碰 child process。

### 2.4 对话完成判定

```
prompt ──ack──► success (可能 agentInvoked: false)
                  │
                  ├─ agentInvoked false 或后续 prompt_result false → 本地完成（slash）
                  └─ agent_start … agent_end { isTerminal !== false } → 一轮结束
```

`isTerminal === false` 表示还有维护/异步续跑，输入框保持「运行中」。子智能体完成走 `subagent_lifecycle` / async-result，不要误当成主会话结束。

### 2.5 审批

RPC 会发 `extension_ui_request`（confirm/select/input/editor）。webview 做模态，回 `extension_ui_response`。

超时按 OMP 默认。用户关 Tab 时，未完成的 UI request 一律 `cancelled`。

v1 不实现 `custom()` TUI 组件。`editor` 用 VS Code 输入框或简单 textarea。

### 2.6 文件与 diff（v1 最小）

听 `tool_execution_end` 里 `edit`/`write` 的 path，卡片上「在编辑器打开」。不做完整 checkpoint/rollback（那是后做，且 OMP 已有 rewind）。

---

## 3. RPC 合同与上游缺口

权威：`omp://rpc.md`。下列是本插件的用法，不是协议定义。

### 3.1 已有、v1 必接

| 命令/事件 | 用途 |
|---|---|
| `negotiate_protocol` v2 | 大帧、分页 |
| `get_state` | sessionFile、model、thinking、streaming、contextUsage、todos |
| `prompt` / `steer` / `follow_up` / `abort` | 对话 |
| `get_messages_page` | 打开 Tab / resume 后拉历史 |
| `set_model` `get_available_models` `cycle_model` | 模型 |
| `set_thinking_level` | thinking |
| `new_session` | 仅当复用进程时；本产品新 Tab 用新进程，一般不调用 |
| `set_session_name` | 改 Tab 标题 |
| `set_subagent_subscription` `progress` | 卡片状态 |
| `get_subagents` | 列表 |
| `get_subagent_messages` | 只读过程（可选，终稿优先 `agent://`） |
| `get_available_commands` | slash 补全 |
| `extension_ui_*` | 审批 |
| `agent_*` `message_*` `tool_execution_*` `goal_updated` | 渲染 |

主会话 **不要** 调 `switch_session` 来切 Tab。

### 3.2 上游缺口（OMP 仓库，不是本仓库）

按优先级：

| ID | 缺口 | 没有它 |
|---|---|---|
| U1 | `list_sessions` `{ cwd?, limit? }` → `SessionInfo[]` | picker 只能扫 `~/.omp/agent/sessions/<encoded-cwd>/`，encoded-cwd 与 title slot 会和 OMP 漂移 |
| U2 | `get_state.mode` + `set_mode: none\|plan\|goal\|vibe` | 只能 `prompt("/plan")`，RPC 对 TUI-only 命令可能当普通文本 |
| U3 | `get_mcp_servers` / `set_mcp_enabled` / `reload_mcp` | 只能解析 mcp.json 多源，开关不能热生效 |

**策略**：Phase 0 提 issue / PR 到 oh-my-pi。Phase 1–2 可降级：

- U1：只扫当前工作区 bucket，文档写明限制
- U2：先发 slash，并用 `get_state` 轮询不到 mode 时用本地乐观状态，resume 后可能不准
- U3：读 `.omp/mcp.json` + 用户 mcp.json，开关写文件并提示「需重载实例」

缺口补上后删降级，不要双轨长期并存。

### 3.3 只读子智能体怎么拿正文

1. 订阅 `progress`，卡片显示状态  
2. 点开：优先让主会话 `read` `agent://<id>`（host 发 `prompt` 太重）—— **不要** 为了看输出再开一轮模型  
3. 正确：extension host 直接读 session artifacts 目录下 `<id>.md`（路径从 `get_subagents` / 会话文件旁 artifacts 解析），或后续若 RPC 增加 `get_subagent_output` 则改走 RPC  
4. 过程摘要：artifacts `<id>.jsonl` 或 `get_subagent_messages`

v1 实现选：进程 cwd + sessionFile 旁 artifacts。解析失败则卡片只显示「完成，输出不可读」。

计划正文：从 transcript 里 plan 工具结果 / 计划文件路径读 markdown。具体字段以 OMP plan-mode 落盘为准（批准流见 omp `approved-plan.ts`）。实现阶段对着真实 `/plan` 会话抓一帧，不要猜。

---

## 4. 仓库与技术选型

本仓库当前只有计划。Phase 0 起在本仓库建插件，不放进 oh-my-pi monorepo（宿主应跟 OMP 发版松耦合）。

```
omp-studio/
  docs/dev-plan.md          本文
  AGENTS.md
  README.md
  extension/                Phase 0 创建
    package.json            publisher: cloudomni, name: omp-studio
    tsconfig.json
    src/
      extension.ts
      instance-manager.ts
      rpc/
        process.ts
        client.ts
        types.ts            从 omp rpc-types 抄一份冻结的子集，标 OMP 版本
      session-picker.ts
      mcp.ts
      artifacts.ts          读 agent:// 对应 md
      providers/sidebar.ts
      shared/protocol.ts
    webview/
      main.ts
      styles.css
    .vscodeignore
```

| 项 | 选择 | 原因 |
|---|---|---|
| 语言 | TypeScript 5 strict | VS Code 生态 |
| bundler | esbuild：host + webview 各一包 | 与常见插件一致 |
| webview UI | 轻量自绘，不引入 React 除非对话列表撑不住 | 侧栏窄，依赖要小 |
| markdown | 现成精简渲染（如 markdown-it），thinking 折叠 | 不引入 antd |
| 测试 | vitest 单测 RpcClient 帧；fixture JSONL | 不强制 vscode-test 到 Phase 3 |
| 包管理 | npm | 与 OmniGate web 一致即可 |
| 引擎 | VS Code ^1.100 | 与 Pi 插件下限对齐 |
| omp | 本机二进制，设置 `ompStudio.ompPath` | 不 bundle |

`rpc/types.ts` 注释冻结的 OMP 版本（例如「对齐 omp 0.x.y rpc.md」）。OMP 改协议只改这一层。

---

## 5. 阶段

每阶段有可运行产物和验收。未验收不进入下一阶段。

### Phase 0 — 仓库与 RPC 探针（约 3–5 天）

**做**

- `extension/` 脚手架：激活、侧栏 webview 占位、「OMP Studio」视图容器
- `RpcProcess` + `RpcClient`：spawn、ready、v2 negotiate、`get_state`、stdin 关闭清理
- 命令 `OMP Studio: Diagnose`：输出 omp 路径、版本、`get_state` 摘要到 Output Channel
- 向上游开 U1/U2/U3 issue（可先 issue 后 PR）

**验收**

- F5 出侧栏
- 工作区有 `omp` 时 Diagnose 打印 `sessionFile` 与 model
- 关掉视图/窗口无僵尸 `omp` 进程（`pgrep -a omp`）

**不做**：聊天 UI、多 Tab

### Phase 1 — 单实例对话（约 1.5–2.5 周）

**做**

- 一个默认 Tab，一个进程
- 对话列表：user / assistant 文本 / thinking 折叠 / 工具卡片骨架（名+状态）
- 输入框：Enter 发送，Esc abort，流式中 Enter = followUp，修饰键 steer（与 TUI 对齐：文档写清快捷键）
- `get_messages_page` 打开已有空会话的历史（新进程无历史则空）
- `extension_ui_request`：至少 confirm + select
- 状态行：model、context %、streaming

**验收**

- 对真实 `omp` 发「列出当前目录文件」，看到流式文本和工具卡片
- 审批弹窗能点允许/拒绝，拒绝后会话不卡死
- abort 后可再发一条

### Phase 2 — 多实例 Tab（约 1–2 周）

**做**

- Tab 条：new / select / close
- InstanceManager：N 进程，活跃视图只订阅当前 Tab 的 delta（后台仍收事件，更新 ● 与 unread）
- 历史 picker：U1 或降级扫描；resume 新进程
- jsonl 占用锁：`Map<sessionFile, tabId>`
- 关窗口 `deactivate` 杀全部
- 软上限 4

**验收（硬）**

1. Tab A 发长任务（例如「解释本仓库结构」）  
2. 立即 `+` Tab B 发另一条  
3. 切回 A，A 仍在流式或已完成，**没有被 abort**  
4. 关 B，A 不受影响  
5. 同一 jsonl 不能开两个 Tab  

### Phase 3 — 模式与模型（约 1 周）

**做**

- 分段控件 Normal/Plan/Goal/Vibe
- U2 优先；否则 slash + 乐观 UI，并在 Output 打警告
- 互斥：plan/goal → vibe 先确认退出
- 模型 quick pick + thinking 循环
- Tab 标题：sessionName，空则首条用户消息截断

**验收**

- 新 Tab 默认 Normal，能切 Plan 再切回（以 `get_state.mode` 或 OMP 可见行为为准：Plan 下不应出现 write 工具成功）
- 模型切换后下一轮请求用新模型（看 `get_state.model`）
- 两个 Tab 模式独立

### Phase 4 — 视图栈：子智能体与计划（约 1.5–2 周）

**做**

- `set_subagent_subscription: progress`
- 对话中 task 卡片：「查看输出」
- push 只读页：标题、状态、markdown 正文（artifacts `<id>.md`）
- `← 返回`
- Plan：检测计划产物，入口「查看计划」；只读 markdown；批准/继续改计划若 RPC 无专用命令则走 slash `/` 或主会话 prompt，按钮只是快捷方式
- 只读页无输入框
- 后台 Tab 子 agent 完成 → 该 Tab unread

**验收**

- 主会话成功派一个 scout（或任意 task），点开看到终稿，返回后输入框仍在对话层
- 只读页敲键盘不会 `prompt`
- Plan 会话能打开计划正文并返回

### Phase 5 — MCP 与打磨（约 1 周）

**做**

- MCP 面板：列表、来源、启用开关（U3 或写文件 + 提示重载）
- 设置：`ompPath`、`maxInstances`、`approvalModeHint`
- 工具卡片「打开文件」
- slash `/` 补全（`get_available_commands`）
- 空态：未装 omp、无工作区、进程 failed 重开
- README 安装：vsix / 依赖本机 omp

**验收**

- 无 omp 时侧栏可懂
- MCP 列表非空（若用户已有 mcp.json）
- vsix 安装到干净 VS Code 能激活

### Phase 6 — 发布（按需）

- Marketplace / Open VSX 账号、图标、changelog
- 对 OMP 小版本做兼容表（设置里显示检测到的 omp 版本）
- 不发布在缺口全靠降级且模式切换经常失灵时

---

## 6. 里程碑与依赖图

```
U1 list_sessions ──┐
U2 set_mode     ──┼─ 降级可先行，补上后删降级
U3 mcp RPC      ──┘

Phase 0 探针
    │
    ▼
Phase 1 单实例聊天 + 审批
    │
    ▼
Phase 2 多 Tab 并发          ← 产品核心，可在模式之前
    │
    ├─► Phase 3 模式/模型
    │
    └─► Phase 4 视图栈（可与 3 部分并行，但依赖 1 的卡片）
            │
            ▼
        Phase 5 MCP + 打磨
            │
            ▼
        Phase 6 发布
```

Phase 2 是差异化（真并发）。Phase 4 是你强调的「看执行效果」。两者都比 MCP 编辑器重要。

---

## 7. 验收清单（发布前总表）

功能：

- [ ] 本机 `omp --mode rpc` 可被插件拉起、关掉无僵尸
- [ ] 单 Tab 流式对话 + 工具卡片 + abort
- [ ] 审批 confirm/select 闭环
- [ ] 两 Tab 同时跑，切走不 abort
- [ ] 历史会话新 Tab resume，同 jsonl 不双开
- [ ] Normal/Plan/Goal/Vibe 切换（或文档标明 slash 降级限制）
- [ ] 模型切换
- [ ] 子智能体只读进/出
- [ ] 计划只读进/出
- [ ] MCP 列表可见

质量：

- [ ] 关窗口无残留 omp
- [ ] 进程崩溃 Tab 显示 failed，可关
- [ ] webview 与 host 协议无 any 互发
- [ ] `rpc/types.ts` 标注对齐的 omp 版本

---

## 8. 风险

| 风险 | 影响 | 处理 |
|---|---|---|
| U2 迟迟不补，`/plan` 在 RPC 当普通文本 | 模式切换假的 | Phase 0 先验证 `prompt("/plan")` 在当前 omp 是否生效；无效则 Phase 3 阻塞，或自己 PR |
| 多进程抢 MCP stdio 端口/同名 server | 偶发失败 | 文档：并发实例共享用户 MCP；失败只影响该 Tab |
| artifacts 路径因 OMP 改版漂移 | 子智能体正文空白 | artifacts 解析集中在 `artifacts.ts`；失败有明确空态 |
| 审批 UI 不全 | 会话卡死 | Phase 1 就把未知 method 一律 cancel 并 notify，禁止悬挂 |
| 费用 | 用户开 4 个 opus | 软上限 + Tab 上 ●；不静默限 |
| OMP 周更 RPC | 插件碎 | types 冻结 + Diagnose 打 protocolVersion；不跟 nightly 硬绑 |
| Windows 杀进程树 | 僵尸 | Phase 2 在 win32 用 `taskkill /T` 或显式 pid 树 |

---

## 9. 工作量（单人，熟 VS Code 扩展）

| 阶段 | 日历 |
|---|---|
| 0 | 3–5 天 |
| 1 | 1.5–2.5 周 |
| 2 | 1–2 周 |
| 3 | 1 周 |
| 4 | 1.5–2 周 |
| 5 | 1 周 |
| **v1 合计** | **约 7–11 周** |
| 6 发布 | 另计 |

不含 OMP 上游 PR 的等待。U2 若必须自己做，另加 3–7 天（在 oh-my-pi 仓库）。

---

## 10. 下一步（本仓库之后）

1. 本机验证：`omp --mode rpc` 发 `get_state`、`prompt("/plan")`、`prompt("/vibe")` 各一帧，把真实 stdout 记进 `docs/rpc-samples/`（Phase 0 任务，现未建目录以免空壳）。
2. 在 oh-my-pi 提 U1/U2/U3。
3. Phase 0 脚手架：`extension/package.json` + RpcClient。

未经用户改本文，不扩大范围（会话树、Hub 接管、SDK、ACP、models.yml GUI）。
