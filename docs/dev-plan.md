# OMP Studio 开发计划

VS Code 侧栏控制面。把本机 `omp` 接到编辑器：多实例并发、模式切换、模型切换、MCP 浏览、子智能体/计划只读查看。

本文是产品与阶段的唯一源。实现约束见根目录 `AGENTS.md`。

---

## 0. 结论

做 **OMP 宿主插件**，不做第二套 agent。

| 决策 | 选择 |
|---|---|
| 集成 | `omp --mode rpc-ui` 子进程。不嵌 SDK，不以 ACP 为主路径 |
| 会话 | 一次新任务 = 一个 RPC 进程 = 一份 jsonl。会话列表切换只换视图，不断进程 |
| 会话操作 | 会话内支持 `switch_session`（复用进程换 jsonl）、`branch`（分叉当前会话）；不做同文件双开。列表行悬停出「置顶 / 完成（归档）」两个图标，改名、复制、关闭在右键菜单里（见 1.2） |
| 子智能体 / 计划 | 会话详情视图栈：整页替换对话，顶上返回 |
| 模式 | `none \| plan \| goal \| vibe`，与模型正交 |
| 配置 | MCP 只浏览/切换/跳文件；模型在**编辑器区设置页**用结构化表单编辑角色与自定义模型（见 1.6）；插件自身的 `ompStudio.*` 也在设置页「扩展」（见 2.7）。不做通用 YAML 编辑器 |
| 与终端 | 不 attach 正在跑的 `omp` |
| RPC 覆盖面 | omp.sh/docs/rpc 的全部命令与事件在插件中有对应能力（2026-09 扩：登录、导出、handoff、host 工具桥、todos、fast mode、队列模式、统计、branch/switch_session） |

v1 可发布条件：两个会话同时跑完一轮（在会话列表里来回切不影响）；模式可切；子智能体/计划能进能返回；工具审批不卡死。

---

## 1. 产品

### 1.1 给谁用

已经在用 `omp` 的人。VS Code 写代码，侧栏指挥同一套 `~/.omp`（模型、密钥、MCP、agent 定义、session jsonl）。

不给：没装 `omp` 的人、想要 Cursor 补全/inline edit 的人、想在 VS Code 里换 Claude/Codex 运行时的人（那是 ACP 客户端）。

### 1.2 侧栏结构

侧栏一个视图两栏：左边聊天区，右边 dock 着 Sessions 面板（会话列表）。没有 Tab 条，不要编辑区大聊天窗（v1）。

```
┌─ 聊天区 ────────────────────────────┬─ Sessions ─────────────┐
│ [←] 测试内容讨论                    │ Sessions    ⌕    ▥     │ ← ⌕ 搜索、▥ 折叠
│ [Agent|Plan|Goal|Vibe] [模型 ▾] […] │ [搜索会话名称    ▽   ✕] │ ← 点 ⌕ 才出现
│                         测试        │  ● 修登录  Plan·运行中 │
│ Completed 4 steps in 3s             │  ● 重构鉴权 Agent·空闲 │
│ 测试成功，我已准备好。               │  ▸ 更多 · 2 个已归档   │ ← 有归档才出现
│ 视图栈 push：子智能体输出 / 计划正文 │                        │
├─────────────────────────────────────┤                        │
│ [＋] [Agent] [模型] [thinking] ◍ [↑]│                        │
└─────────────────────────────────────┴────────────────────────┘
```

- 面板默认展开；折叠按钮（▥）在头部最右、搜索图标右边，折叠后聊天区占满整宽，同一个图标留在聊天区右上角把它叫回来。折叠状态是视图偏好，跟置顶/归档一起由宿主存进 `workspaceState`（webview 每次变更发 `list/prefs`，`ready` 时宿主先回推），跨窗口重载、跨 VS Code 重启。
- 没有活动会话时聊天区只有空白 + 输入框（入口页）：点面板里一行进详情，详情顶部 `←` 取消选中、回空白，不停进程；视图栈 push 仍整页替换聊天区（§1.4）。
- 内容与输入框在一条居中的列里：`max-width` 760px、`min-width` min(320px, 100%)——比列宽时居中、两侧留白，比 320px 还窄就跟着缩，缩不出横向滚动。面板 `width: clamp(200px, 34%, 300px)`。
- 视图窄于 480px 时面板改成覆盖式（浮在聊天区上，左侧竖线 + 阴影），点开一行会话自动折叠面板，先看对话。
- 输入框的附件有两个来源：`＋` 走宿主 `showOpenDialog` 选图，`Cmd+V` 直接把剪贴板里的图片读成字节——字节本来就在 webview 里，不必再绕一趟文件对话框。收 `png / jpg / gif / webp / bmp`（只有 png 原样进 jsonl，其余由 omp 转成 webp），非图片的粘贴一律不拦，照旧走浏览器默认行为。附件是输入框上方一排可单个删除的 chip；发送时以 base64 `images` 随 prompt 发走，队列里的待发条目也带着它们。**只有图片、没有文字**是合法的一回合（omp 存成空文本 + image part），所以空判据是「文本空 且 无附件」。用户气泡在文字下方画缩略图（高度封顶 110px），点开整页预览（`Esc` 或点空白关闭）；文件名只活在输入框里，不进消息、不进队列。
面板头部的放大镜（⌕）后面才是过滤框，形状照 VS Code 自己的 view filter（输入框 + 漏斗 + `✕`，不是工具栏按钮）：默认关闭，点图标展开并放进光标，再点图标、或框空时按 `Esc`，收起。收起顺手清空过滤——看不见过滤框却还在过滤，列表就是在骗人。按**会话名称**子串过滤，大小写不敏感、忽略首尾空格，实例行和文件行一起过滤——过滤的是同一份行，不是换一份数据源。命中数写在行上方，没命中只留一条空态；`✕` 或 `Esc` 清空（`Esc` 在空框时收起过滤框）。搜索的边界就是名称：jsonl 文件名、模式、消息正文都不参与匹配。命令面板「打开历史会话」展开面板、点开过滤框，并把光标放进框里。

┌─ 聊天区（面板折叠）───────────────────┐┌─ Sessions（搜索中）──────┐
│                                       ││ Sessions         ⌕   ▥  │
│             …对话照旧…                ││ [鉴权           ▽    ✕] │
│                                       ││ 2 个会话（1 个运行中）   │
├───────────────────────────────────────┤│  ● 修登录 Agent·运行中   │
│ [＋] [Agent] [模型] ◍ [↑]             ││  ● 重构鉴权 Plan·可恢复  │
└───────────────────────────────────────┘└──────────────────────────┘

一张列表装两种行，按 jsonl 去重——同一份会话不会既是实例行又是文件行：

1. **实例行**：正在运行的会话，也就是「现在有哪些 Tab」。行首圆点和状态文字说明这个实例此刻在干什么：`待回答`（蓝点，omp 卡在审批/提问上等用户）/ `运行中`（灰转圈，一轮在跑；模型自动重试期间变红转圈、文字 `重试中`）/ `完成`（绿点，进程活着且上一轮已结束）/ `失败`（红点，进程崩溃或模型调用终止）；没有实例在运行的行不画圆点，meta 读 `可加载`；`·` = 有未读输出。模式名取实例上报值。行内不常驻按钮：**悬停**（或键盘 Tab 到行内）才出现两个图标——置顶（codicon pin）、完成（codicon check）。其余操作在行的**右键菜单**里：打开会话、改名（`set_session_name`，不必先切到它）、置顶/取消置顶、标记完成/取消归档、复制名称、复制会话文件路径、关闭会话（停该实例，运行中先确认）。右键菜单吃掉 VS Code 自带的那份 webview 菜单（`preventDefault` + `preventDefaultContextMenuItems`），否则编辑器的「复制」会和插件的复制项撞在一起。
2. **文件行**：这个工作区落盘、却没有实例打开的 jsonl。点一行 = **新实例 + `--resume <path>`**，meta 读 `可加载`、行首不画圆点。它的右键菜单更短：恢复会话（新实例）、置顶/取消置顶、标记完成/取消归档、复制名称、复制会话文件路径——没有实例，就没有改名和关闭。

**完成（归档）** 是这一行移出列表，不是删 jsonl：归档键与置顶键同源（jsonl 路径，实例还没有 jsonl 时用实例 id），由宿主存进 `workspaceState`（`list/prefs` 消息，webview 重载不丢），不动会话文件、不碰 omp 进程。归档实例行**先停进程**——列表是唯一能点到它的地方，把进程留在隐藏的行背后等于把它丢在那里（一轮在跑时先确认「停止并归档」）。归档的行默认**收在整张列表最下面的 `更多 · N 个已归档` 里**（这一行本身就是开关，默认收起，点一下展开/收起，展开时箭头转下、行内缩进一条竖线；列表空了就只剩它，另加一句「这里都已归档。」）。展开后每行与活跃行同款：点开 = 恢复/切到它，行内 ✓ = 取消归档、放回活跃列表（放回后行使 `· 已归档` 且变暗）。计数只算当前过滤命中的行：搜索不把归档行翻出来，只让这个计数变窄、展开后只列命中的那几行。

排序：置顶的（先实例行、再文件行）→ 实例行（宿主创建顺序）→ 文件行（时间倒序）→ 归档的（`更多` 展开时才出现，同样置顶优先）。置顶与归档都按 jsonl 记住（`workspaceState`），同一份会话恢复后仍在原位。文件行的边界：只有这个工作区 bucket 里**最近的 50 条**（`listHistoryEntries` 上限，U1 未补），跨 bucket、全文（消息正文）搜索不做，别拿扫盘冒充。

进入插件落在聊天区的空白页（面板在右边，默认展开）。点面板里一行进详情；详情顶部 `←` 取消选中、回空白，不停进程。空白页的输入框发送 = 新建实例 + 发这条 prompt，直接进详情。输入框那一排 `＋ / 模式 / 模型 / thinking` 与详情页同一套：附件、模型、thinking 是**新会话的起始状态**（发送时先 `set_model` / `set_thinking_level`，再随首条 prompt 发附件）；模型目录来自 `omp models ls --json`（此时没有实例可问），标签默认显示 config.yml 的 `modelRoles.default`，模式与详情页一样只读（U2 缺口，见 §1.5）。

输入框的补全两个输入框一套：`@` 列工作区文件（`workspace.findFiles`，与实例无关，所以两边完全相同）；`/` 列 slash 命令——详情页用该实例握手/`available_commands_update` 给的表，空白页没有实例可问，宿主就起一个**一次性** `omp --mode rpc --no-session` 探测 `get_available_commands`（纯命令表，无 UI 请求，用 rpc 即可）（`omp` 没有 CLI 读法），读完即关，不写 jsonl（`--no-session`）、不出现在 Sessions 面板里。探测失败只记日志：`/` 列表空着，`@` 照常。

输入框那一排、思考等级右边的那个圆是**上下文用量**：弧长 = `get_state` 的 `contextUsage.percent`，圈里是同一个百分比的整数，悬停显示 omp 报的**已用 / 窗口** token（`contextUsage.tokens` / `contextUsage.contextWindow`）。75% 起转黄、90% 起红，跟别处同一套色阶；omp 还没报过百分比的会话（含空白页输入框——那里根本没有实例可问）不画圆，因为 0% 是编出来的数。

Activity Bar 一个图标，一个 `WebviewView`。

**设置页（不在侧栏）**

侧栏只承载会话。设置页是**编辑器区的一个 `WebviewPanel` 页签**，布局照 VS Code 设置页：左边一列分类（概览 / 模型角色 / 自定义模型 / 其他 / 扩展，各带条目数），右边 sticky 头（当前分类名 + 搜索框 + 重新读取）+ 该分类的表单。切分类只换右栏：不重开页签，不丢已展开的提供商、正在编辑的表单或搜索词。搜索过滤的是**当前分类**，左栏徽标显示各分类命中数；当前分类没命中但别处有时，空态给出跳转入口。

```
┌─ 编辑器页签：OMP 设置 ──────────────────────────────────────────────┐
│ 概览            │ 概览                     [搜索…]   [重新读取]     │
│ 模型角色  6     │ agent: ~/.omp/agent · omp/18.0.11                  │
│ 自定义模型 3    │                config.yml ↗    models.yml ↗       │
│ 其他      2     ├────────────────────────────────────────────────────┤
│ 扩展      1     │ 模型角色  6 个角色       [自定义模型 3 个提供商…]  │
│                 │ 其他      2 项设置       [扩展      1 项设置]      │
│                 │ 写入纪律：config.yml 由 omp 写 / models.yml 由本页写│
├─────────────────┴────────────────────────────────────────────────────┤
│ 模型角色（分类页示例）                                              │
│   default  新会话默认模型   [OmniGate/glm-5 ▾] :[xhigh ▾]    [清除]  │
│   smol     快/轻任务        [未设置 ▾]         :[— ▾]                │
└─────────────────────────────────────────────────────────────────────┘
```

为什么破例放到编辑器区（本节开头「不要编辑区大聊天窗」不是这条）：

- 它不是对话窗，不碰 transcript、占不到侧栏的状态机。
- 自定义模型的表单字段多（提供商 5 项 + 每个模型 8 项），侧栏 300–400px 放不下，硬塞会把交互做残。
- VS Code 原生设置页（`contributes.configuration`）装不下表格，只能渲染 string/number/boolean 输入框；把 provider+models 塞进一个 JSON blob 就正好是本文禁止的「第二套完整编辑器」。所以只能是自绘 WebviewPanel。

入口：命令 `ompStudio.settings`（`view/title` 齿轮）。单例——已开就 `reveal()`。

标题栏（`view/title`）只有三个入口：新建实例、打开历史会话、设置页。会话操作菜单（重命名 / 统计 / branch / 登录 / 队列模式等 RPC 能力）**不挂入口**——`ompStudio.sessionMenu` 命令与 webview 里的 overlay 都留在代码里，只是不再显示按钮。这些能力本身仍然可用：改名在列表行右键菜单里，其余按需再接入口。

### 1.3 会话 = 并发实例

用户要的是「两个开发任务同时跑」，不是一条对话的树分叉。并发不变，入口从 Tab 条换成会话列表。

| 操作 | 行为 |
|---|---|
| 空白页（无活动会话）输入框发送 | 新 `omp --mode rpc-ui`，cwd = 工作区根，新 jsonl，新实例；先按输入框那一排的选项 `set_model` / `set_thinking_level`，再发这条 prompt（带附件）；UI 进该会话详情 |
| 点实例行 | 只换可见 transcript / 事件源。其它实例继续 |
| 点文件行 | **新实例 + `--resume <path>`**，进该会话详情 |
| 悬停行内 置顶 | 置顶/取消置顶。只改这个列表的顺序，按 jsonl 路径存进宿主 `workspaceState`：同一份会话恢复后仍排最前 |
| 悬停行内 完成 | 归档（= 完成）这一行，移出列表。实例行先 `tab/close` 停进程，流式或有未完成工具调用时确认；只动视图，不动 jsonl |
| 行内右键菜单 | 打开会话 / 改名（`set_session_name`，作用于这一行的实例，不必先切到它）/ 置顶 / 归档 / 复制名称 / 复制文件路径（`clipboard/write`，宿主写剪贴板）/ 关闭会话（停该实例，运行中先确认）。文件行没有改名和关闭 |
| 已归档 N 个 · 显示 | 把归档的行召回来（变暗、meta 带 `· 已归档`），再点一次收起。计数只算当前过滤命中的行 |
| 面板搜索图标 / 过滤框 | 按会话名称子串过滤，作用于同一张列表（不换数据源，也没有模式筛选）。过滤掉的实例仍在跑 |
软上限 **4** 个运行中实例（设置页「扩展」里改，见 §1.6/§2.7）。超出提示费用/CPU。关 VS Code 窗口停掉全部子进程。

不做：把子 agent jsonl 当列表行。（Tab 内 `switch_session` / `branch` 仍可用，见 `rpc/types.ts`；同文件多实例双开仍然禁止。）

软上限 **4** 个运行中实例。超出提示费用/CPU。关 VS Code 窗口停掉全部子进程。

### 1.4 视图栈

每个实例自己一条短栈。默认 `[对话]`。

对话本身按时间线渲染，不堆卡片：一次工具调用一行（图标 + 动词 + 文件/命令 + `+N -M`，失败追加红色「执行失败」），一段思考一行（`思考 · 持续了 N 秒`）；点任意一行展开结果正文、错误输出与文件入口。秒数是宿主按真实流计时的实测值，从历史 jsonl 回放的会话没有实时事件，就不显示秒数。

- 对话里的 `task` 行内 →「查看输出」→ push `[子智能体: <id>]`
- Plan 产出计划 →「查看计划」→ push `[计划]`
- Goal 若有目标摘要 → 同样 push `[目标]`
- 详情顶栏 `←`：栈深 > 1 时 pop 回对话；栈底时回会话列表（进程继续跑）
- 切会话保留各实例自己的栈

### 1.5 模式

挂在当前 Tab 的进程上，不跟视图层走。看子智能体时模式条禁用或收起，返回后恢复。

| UI | OMP | 主会话 |
|---|---|---|
| Normal | `none` | 日常批平：读写、命令、派子 agent |
| Plan | `plan` | 只读规划；批准后才执行 |
| Goal | `goal` | 盯目标推进 |
| Vibe | `vibe` | 导演；worker 干活。与 plan/goal（含暂停）互斥 |

**哪些真能点到**（2026-09 本机实测；证据 `docs/upstream-issues.md` U2 与录制样本 `rpc-samples/plan-yolo.jsonl`）：omp 18 的 RPC 既没有 `get_state.mode` 也没有 `set_mode`，进程起来之后改不了模式。菜单只列真能走的路，其余禁用并写出原因：

- **Plan 可用**，走 omp 自己的 headless 规划流程 `omp --plan-yolo`（插件固定配 `--plan-yolo-into <当前模型>`，避免换成用户可能没配的 `@smol` 角色）：
  - 新会话：spawn 参数直接带 `--plan-yolo`；
  - 已有会话：**换掉该 Tab 的进程**，`--resume` 同一份 jsonl——标题、历史、置顶、归档键都跟 jsonl 走，只有进程与视图栈是新的（§2.2）。RPC 不能原地开模式，插件也不做「本地乐观状态」：那是会撒谎的第二份状态。
  - 反向同理：Plan Tab 选 Agent 是同一条重启，只是撤掉 `--plan-yolo`。
  - 一轮在跑时不给切（行内说明「等这轮结束」）；没有会话文件时不给切（重启后没有历史可回）。
- **Goal/Vibe 不可用**：omp 只给了 Plan 的 headless 入口，这两个只能进终端切；菜单行禁用并写明原因，不是画出来点不动。
- 将来 omp 的 `get_state` 带上 `mode`（`set_mode` 生效）时，同一份菜单自动全开、原地切——靠能力探测分叉，不维护两套 UI。

**Plan 的进出**：`--plan-yolo` 下第一轮只读起草（实测只出现 `read`/`glob`，写盘只有计划文件与 `xd://propose`），omp 自己批准后发一条 `source: "plan-yolo"` 的 notice，再用 `--plan-yolo-into` 那个模型实施。该流程不写 `mode_change` 条目，所以**这条 notice 是 pill 从 Plan 回到 Agent 的唯一证据**，插件据此清 Plan 态（`src/mode.ts` 的 `isPlanHandoff`）。

约束做进 UI：

- Plan/Goal 下点 Vibe → 先提示退出
- Vibe 期间禁用 fork/handoff（OMP 会拒）；本产品本就没有 fork
- 切模式只影响当前 Tab
- 计划批准后 OMP 可能按标题自动命名 → Tab 标题刷新

`set_fast_mode` / steering 不是这四个模式，不进分段控件。

### 1.6 模型与 MCP

**会话内模型**：`get_available_models` + `set_model` + thinking。输入框旁的就近菜单（与思考等级同款，不弹独立面板）。只列有凭证的。这只改当前会话的模型，不动持久配置。

**模型角色（设置页）**：`default / smol / slow / plan / vision / advisor` 六个角色各自指向哪个模型。取值 = `omp models ls --json` 的 `selector`（`Provider/modelId`）+ 可选 `:<thinkingLevel>`（合法等级取该模型的 `thinking[]`）。

- 读：`omp config get modelRoles --json`
- 写：`omp config set modelRoles '<完整 JSON record>'`
- `modelRoles.smol` **不是**可点号寻址的键（`config set` 只认注册过的整键），所以必须读-改-写整条 record；写前立刻重读一次以缩小覆盖窗口。
- `omp config set` **只能写全局**（没有 `--global/--project`）。`modelRoleStorage=project` 时页面如实说明「此处写入仍落全局，按项目的角色请在 omp 终端改或直接编辑项目 `.omp/config.yml`」，并给「打开项目 config.yml」入口。不假装支持。
- 角色改动对**已运行**的实例不生效（配置在进程启动时读），文案与 MCP 统一：「重开 Tab 后生效」。

**自定义模型（设置页）**：可视化增删改 `~/.omp/agent/models.yml` 的 provider 与 model。写盘路径见 §2.7。

**MCP**：列表（名称、来源、启用）。开关。点条目打开 `.omp/mcp.json` 或用户 `mcp.json`。不做 OAuth 向导、stdio 表单。插件永不写 mcp.json（开关走 `/mcp enable|disable`，让 omp 自己写）。

### 1.7 明确不做（v1 及以后默认不做，除非改本文）

- Cursor/Cline：补全、inline edit、自研索引
- 嵌 `@oh-my-pi/pi-coding-agent`
- ACP 主路径
- `/tree` `/fork` 作为产品功能（`branch` 已解除禁止，见 1.3）
- Agent Hub 接管（steer/revive/kill）
- `models.yml` / `config.yml` 的**通用 YAML 编辑器**（自由编辑任意键）。只允许 §1.6 那种按 schema 的结构化表单，且 `config.yml` 一律委派 `omp config set`
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
│    ├─ SettingsService     读/写 omp 配置（§2.7）          │
│    ├─ SidebarProvider     WebviewView                    │
│    └─ SettingsPanel       编辑器区 WebviewPanel（单例）   │
│                                                          │
│  Instance                                                │
│    ├─ RpcProcess          spawn omp --mode rpc-ui           │
│    ├─ RpcClient           JSONL v2                       │
│    ├─ Transcript          消息 + 工具卡片状态             │
│    └─ ViewStack           chat | subagent | plan | goal  │
└──────────────────────────────┬───────────────────────────┘
                               │ stdio JSONL
                               ▼
                    omp --mode rpc-ui (cwd = workspace)
                               │
                               ▼
                    ~/.omp/agent/sessions/<encoded-cwd>/...
```

### 2.1 进程合同

启动新实例：

```bash
omp --mode rpc-ui --cwd <workspaceRoot>
```

打开历史：

```bash
omp --mode rpc-ui --cwd <workspaceRoot> --resume <absolute-jsonl>
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

- `instance/list` 全部实例摘要（id、title、running、busy、unread、mode、sessionFile）
- `sessions/open`（展开面板 + 回空白页：命令面板「新建实例」也落这里） `history/open`（展开面板 + 点开过滤框 + 光标进框，命令面板「打开历史会话」用）
- `transcript/replace` 当前视图的消息快照
- `transcript/delta` 流式增量
- `view/push` `{ kind: "subagent"|"plan"|"goal", title, body }`
- `view/pop`
- `ui/request` 审批/confirm/select/input（对应 `extension_ui_request`）
- `models/list` `mcp/list` `state`（mode、model、thinking、contextUsage）

- `tab/select` `tab/close` `tab/open-history`（列表选行 / 关行 / 恢复历史）
- `session/create-and-send`（列表页输入框：新建实例 + 发 prompt）
- `session/rename { id, name }`（行右键菜单「改名」和会话菜单共用，宿主按 id 找实例，不是只有活动实例能改名）
- `prompt/send` `prompt/abort` `prompt/steer`（`prompt/send` 与 `session/create-and-send` 可带 `attachments: { name, data, mimeType }[]`；宿主只把 `data` / `mimeType` 转成 RPC 的 `images`，文件名不进会话也不进队列）
- `mode/set` `model/set` `models/refresh`（目录未到时 picker 主动重拉） `thinking/cycle`
- `view/open-subagent` `{ id }` `view/open-plan` `view/back`
- `clipboard/write { text }`（右键菜单的「复制名称 / 复制文件路径」；webview 自己碰不到系统剪贴板）
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

### 2.5 交互请求（审批 + 选择题）

传输层是 `omp --mode rpc-ui`（不是 `--mode rpc`）：rpc 模式不注册 `ask` 工具，只有 rpc-ui 才会把 `extension_ui_request` 发出来（见 upstream-issues U4-1）。RPC 会发四类 `extension_ui_request`：`confirm` / `select` / `input` / `editor`。webview 做模态面板，回 `extension_ui_response`。

**select（omp 的 ask 工具，多选）**：omp 每收一个答案就把同一问题再发一遍（标题带 `(N selected)`），直到用户点它自带的 Done 行。宿主按问题文本把连续的 select 轮合并成一次多选：`selected` 随每轮视图下发，webview 纯渲染（已选项画勾、Done 行沉底、`Other (type your own)` 显示为「自己输入…」），答案永远是行自身的 `value` 原文。omp 对同一 request id 的重复 answer 会清空它的多选状态重问——webview 端禁止对同一 id 答两次。answer 后面板不立刻关：omp 毫秒级就重发下一轮，面板先进半透明 `submitted` 态，宿主 400ms 内没等到新帧才真正关闭。

**confirm**：允许/拒绝两行。omp 的标题是多行的（`Allow tool: …` + 路径 + 内容），按 `pre-wrap` 渲染。

**input / editor**：输入框 / textarea；editor 的标题里塞着上下文，宿主按首个空行拆成问题与正文。面板自动聚焦输入位。

超时按 OMP 默认（`timeoutMs` 有值时面板展示倒计时说明）。用户关 Tab 时，未完成的 UI request 一律 `cancelled`。非活动 Tab 来了交互请求：只弹通知 + 列表徽标（`awaiting`），不抢当前视图；切回该 Tab 时面板随 `pushSession` 补发恢复。

v1 不实现 `custom()` TUI 组件。多问题序列（`(n/m)` 进度）只展示徽标，不提供回退上一题（omp 的 RPC 出口没有左右导航，见 U4-2）。

### 2.6 文件与 diff（v1 最小）

听 `tool_execution_end` 里 `edit`/`write` 的 path，卡片上「在编辑器打开」。不做完整 checkpoint/rollback（那是后做，且 OMP 已有 rewind）。

### 2.7 设置页：协议与四条写入路径

面板是另一个 webview，所以协议另开两份联合（仍在 `src/shared/protocol.ts`）：`SettingsHostMessage`（`snapshot` / `busy` / `notice`）与 `SettingsWebviewMessage`（`ready` / `refresh` / `role/set` / `scalar/set` / `host-setting/set` / `provider/save` / `provider/delete` / `model/save` / `model/delete` / `file/open`）。侧栏的 `HostMessage` 不塞面板专用分支。

读取一律走 CLI，不 spawn RPC 实例：

| 用途 | 命令 |
|---|---|
| 设置快照 | `omp config list --json`（扁平 map，`{value,type,description}`；`description` 直接当帮助文本用） |
| 模型目录 / 角色下拉 | `omp models ls --json`（`{models:[{provider,id,selector,name,contextWindow,maxTokens,reasoning,thinking[],input[],cost{}}]}`） |
| 版本 | `omp --version` |

**注意**：`config list --json` 不含 enum 的 `values`，需要下拉的键取值列表由插件侧维护（只覆盖设置页暴露的那几个键）。不调 `omp models refresh`——它会改 `models.db`。

**三套 thinking 取值，别混用**（实测 omp 18.0.11；混用会让页面给出 omp 拒绝的值）：

| 用途 | 合法取值 | 依据 |
|---|---|---|
| 模型自身等级：`models.yml` 的 `thinking:`、角色 selector 的 `:<level>` 后缀 | `minimal low medium high xhigh max` | 二进制里 `models.yml` 的 schema 联合类型就是这个集合，**既没有 `off` 也没有 `auto`** |
| `defaultThinkingLevel`（设置页「其他」） | `minimal … max` + **`auto`** | registry 里 `values: [...Wo, "auto"]`；`omp config set defaultThinkingLevel off` 报 `Valid values: minimal, low, medium, high, xhigh, max, auto` |
| 会话内思考菜单（RPC `set_thinking_level`） | `inherit off minimal … max` | 既有 `src/rpc/types.ts` 的 `ThinkingLevel`，与上面两套都不同 |

`auto` 只作为默认值有意义（逐轮分类），`off` 属于会话菜单。代码里对应 `MODEL_THINKING_LEVELS` 与 `DEFAULT_THINKING_LEVELS` 两个常量。

四条写入路径，严格的单写者纪律：

| 目标 | 谁写 | 方式 |
|---|---|---|
| `config.yml`（`modelRoles`、`defaultThinkingLevel`） | **omp** | `omp config set <key> <value>`。插件永不直接写这个文件，因此也自动继承 omp 的 `.lock` 与 node 级定向更新 |
| `models.yml`（自定义 provider / model） | **插件** | 唯一例外。omp 没有任何写它的命令（`omp models` 只有 `ls/list/find/refresh`），要可视化编辑只能自写 |
| `mcp.json` | **omp** | 开关走 `/mcp enable\|disable <name>`，插件永不写 |
| `ompStudio.*`（插件自己的设置，如并发实例上限） | **VS Code 配置** | 走宿主注入的 `HostSettingsWriter`（`workspace.getConfiguration("ompStudio").update(…, Global)`），与上面三条无关。工作区/文件夹级覆盖会压过全局写，写不生效时页面明说 |

`models.yml` 是自己写盘，所以要三重保护：

1. **保注释编辑**：`yaml` 包的 Document API（`parseDocument` / `setIn` / `deleteIn` / `toString`），只动目标节点，用户的注释、空行、缩进原样留下。`js-yaml` 不保注释，不能用。
2. **写前沙箱校验**：`mkdtemp` 造临时 agent 目录，只放编辑后的 `models.yml`，用 `PI_CODING_AGENT_DIR=<tmp>` 跑一次**真实的** `omp models ls --json`。期望的 provider/model 没出现，或 stderr 含 `models.yml validation failed` → **根本不落盘**，把 omp 原文报给用户。

   校验结果必须区分两种失败（`kind`）：`unresolved` = omp 读到了文件但那个 provider/model 不在里面，**拦下**；`cli` = omp 自己没跑起来（首次使用的空目录没有 catalog DB 之类），**说明不了文件的问题**，只警告并退到写后校验。不加这个区分，一个无关的 CLI 抖动就会把合法的保存挡掉。

   注意 `models.yml` 校验失败会让 omp **禁用所有自定义 provider**，所以「解析没报错」比「目标 provider 出现」更强的断言在空 provider 上不成立：目标 provider 一个模型都没有时，只断言 stderr 无 validation failed。

3. **原子写 + 备份**：先留 `models.yml.bak-<ts>`，再写 tmp 文件 + `rename()` 覆盖。写完用**真实 agent 目录**再校验一次，`unresolved` 就回滚。

配套约束：写前比对上次读到的 mtime，不一致就拦下提示「文件已被外部修改，请重新读取」；apiKey **永不进 webview**（只传 `hasApiKey: boolean`，表单留空 = 保留原值）；provider/model 的 id 创建后不可改名（改名等于删+建，注释会错位）。

---

## 3. RPC 合同与上游缺口

权威：`omp://rpc.md`。下列是本插件的用法，不是协议定义。

### 3.1 已有、v1 必接

| 命令/事件 | 用途 |
|---|---|
| `negotiate_protocol` v2 | 大帧、分页 |
| `get_state` | sessionFile、model、thinking、streaming、contextUsage、todos |
| `prompt` / `steer` / `follow_up` / `abort` | 对话；`prompt.images[] = { type: "image", data: <base64>, mimeType }`，用户 message 里与文本同形（`get_messages_page` 全量回读）。omp 18.0.11 本机实测：png 原样落盘，jpeg/gif/webp/bmp 由 omp 转成 webp 再落盘；空文本 + 图片是合法回合 |
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
| U2 | `get_state.mode` + `set_mode: none\|plan\|goal\|vibe` | Plan 只能靠 `--plan-yolo` 换进程达成（Goal/Vibe 没有任何 headless 入口）；中会话切模式 = 重启该 Tab 的进程，不能原地切 |
| U3 | `get_mcp_servers` / `set_mcp_enabled` / `reload_mcp` | 只能解析 mcp.json 多源，开关不能热生效 |

**策略**：Phase 0 提 issue / PR 到 oh-my-pi。Phase 1–2 可降级：

- U1：只扫当前工作区 bucket，文档写明限制
- U2：不做本地乐观状态（会撒谎）。Plan 走 `--plan-yolo`（新会话带 spawn 参数，已有会话重启同一 jsonl 并 `--resume`），Goal/Vibe 在菜单里禁用并写明「只能在 omp 终端里切」；`prompt("/plan")` 实测**不是**模式开关（当普通文本发给模型），不作为降级路径
- U3：读 `.omp/mcp.json` + 用户 mcp.json，开关写文件并提示「需重载实例」

缺口补上后删降级，不要双轨长期并存。

### 3.3 只读子智能体怎么拿正文

1. 订阅 `progress`，卡片显示状态  
2. 点开：优先让主会话 `read` `agent://<id>`（host 发 `prompt` 太重）—— **不要** 为了看输出再开一轮模型  
3. 正确：extension host 直接读 session artifacts 目录下 `<id>.md`（路径从 `get_subagents` / 会话文件旁 artifacts 解析），或后续若 RPC 增加 `get_subagent_output` 则改走 RPC  
4. 过程摘要：artifacts `<id>.jsonl` 或 `get_subagent_messages`

v1 实现选：进程 cwd + sessionFile 旁 artifacts。解析失败则卡片只显示「完成，输出不可读」。

计划正文：从 transcript 里 plan 工具结果 / 计划文件路径读 markdown。具体字段以 OMP plan-mode 落盘为准（批准流见 omp `approved-plan.ts`）。对着真实录制抓帧，不要猜：`rpc-samples/plan-yolo.jsonl` 就是 `--plan-yolo` 从只读起草到实施的一整轮（含 `xd://propose` 与批准 notice）。

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
      omp-config.ts         包 omp config / omp models 的 CLI 调用 + 纯解析
      models-file.ts        models.yml 保注释变换 + 沙箱校验 + 原子写
      settings.ts           SettingsService：设置快照与各类编辑
      providers/sidebar.ts
      providers/settings-panel.ts   编辑器区设置页（单例）
      shared/protocol.ts
    webview/
      main.ts               侧栏入口
      settings.ts           设置页入口
      settings-view.ts      设置页纯逻辑（DOM-free，可单测）
      dom.ts                el/button/toast 共用小工具
      styles.css
    test/
      unit/  fixtures/  integration/  ui/
    .vscodeignore
```

| 项 | 选择 | 原因 |
|---|---|---|
| 语言 | TypeScript 5 strict | VS Code 生态 |
| bundler | esbuild：host 一包 + webview 两个入口（侧栏、设置页） | 与常见插件一致 |
| webview UI | 轻量自绘，不引入 React 除非对话列表撑不住 | 侧栏窄，依赖要小 |
| YAML（只读+写 models.yml） | `yaml`（eemeli）Document API | 唯一能保注释的选项；`js-yaml` 会毁注释。只用于 `models.yml`，`config.yml` 一律委派 omp |
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
- 输入框：Enter 发送，Esc /「中止」按钮 abort，流式中 Enter = followUp，修饰键 steer（与 TUI 对齐：文档写清快捷键）
- 输入框附件：`＋` 选图、`Cmd+V` 粘图，随 prompt 发 base64；用户气泡缩略图 + 点开预览
- `get_messages_page` 打开已有空会话的历史（新进程无历史则空）
- `extension_ui_request`：至少 confirm + select
- 状态行：model、context %、streaming

**验收**

- 对真实 `omp` 发「列出当前目录文件」，看到流式文本和工具卡片
- 审批弹窗能点允许/拒绝，拒绝后会话不卡死
- abort 后可再发一条
- 粘一张剪贴板图片后回车，omp 收到 image part（jsonl 里看得到），气泡下出现缩略图，点开能看大图

### Phase 2 — 多实例 Tab（约 1–2 周）

**做**

- Tab 条：new / select / close
- InstanceManager：N 进程，活跃视图只订阅当前 Tab 的 delta（后台仍收事件，更新 ● 与 unread）
- 会话过滤：`history/refresh` 拉桶内会话文件（上限 50），名称过滤在 webview；resume 新进程
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

- 模式菜单（Agent/Plan/Goal/Vibe），每行写清能不能点、点了做什么、不能点为什么
- Plan 走 `--plan-yolo`：新会话带 spawn 参数，已有会话重启该 Tab 的进程并 `--resume` 同一 jsonl；Goal/Vibe 禁用并写明只能在 omp 终端切
- 互斥：plan/goal → vibe 先确认退出
- 模型就近菜单 + thinking 循环
- Tab 标题：sessionName，空则首条用户消息截断

**验收**

- 新 Tab 默认 Agent；选 Plan 后第一轮只有 `read`/`glob`，写到工作区的 `edit`/`write` 只出现在 `source: "plan-yolo"` 的批准 notice 之后（以真实帧为准，见 `rpc-samples/plan-yolo.jsonl`）
- Plan Tab 选 Agent 后同一份 jsonl 被新进程 `--resume`，历史与标题不丢
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
- 设置：`ompPath`、`approvalMode` 留在 VS Code 原生设置页；`maxInstances` 已在设置页「扩展」（见 §1.3 / §2.7）
- 工具卡片「打开文件」
- slash `/` 补全（`get_available_commands`）
- 空态：未装 omp、无工作区、进程 failed 重开
- README 安装：vsix / 依赖本机 omp

**验收**

- 无 omp 时侧栏可懂
- MCP 列表非空（若用户已有 mcp.json）
- vsix 安装到干净 VS Code 能激活

### Phase 5.5 — 设置页（约 4–6 天）

**做**

- 编辑器区 `WebviewPanel`（单例）+ 命令 `ompStudio.settings`，布局照 VS Code 设置页：左栏分类 + 右栏 概览／模型角色／自定义模型／其他／扩展 五个分类页，sticky 头带搜索框
- `SettingsService`：`omp config list --json` / `omp models ls --json` → 快照；角色与 `defaultThinkingLevel` 走 `omp config set`
- 模型角色卡片：六个角色 × [模型下拉 + thinking 下拉 + 清除]，改动即时保存，行内显示保存中/已保存/失败
- 自定义模型卡片：provider/model 增删改（`models.yml`），三重保护见 §2.7；apiKey 永不进 webview
- 其他卡片：`defaultThinkingLevel` 可改；`modelRoleStorage` 只读 + 诚实说明
- 扩展卡片：`ompStudio.maxInstances`（并发实例上限）数值输入，写 VS Code 配置；写不生效（工作区覆盖）时给警告
- 「在编辑器中打开 config.yml / models.yml」
- 单测：YAML 变换保注释、无改动 round-trip 字节相同、快照解析、表单校验
- 集成验收：`test/integration/settings.test.ts`（`OMP_STUDIO_INTEGRATION=1`），整个套件跑在临时 agent 目录里

**验收**

- 改一个角色 → `omp config get modelRoles` 读到新值；`diff` 备份与现文件，确认**只有 `modelRoles` 段变化**，其余键与注释无损
- 新增一个 provider → `omp models ls --json` 里出现；删掉后 `diff` 归零
- 故意写一个非法 `models.yml`（如 `api` 写错）→ 沙箱校验就拦住，**真实文件 mtime 不变**；`.bak` 回滚可用
- 扩展页把并发上限改成 8 → `settings.json` 的 `ompStudio.maxInstances` 变成 8，且之后第 5 个实例的警告里显示「软上限 8」；工作区里另有一份覆盖时页面给警告
- 设置页保存后：新 Tab 用新角色生效，已开 Tab 不动（与文案一致）

**怎么验收才不碰用户真配置**：`PI_CODING_AGENT_DIR` 不只改 omp 的**读**，也改它的**写**——实测 `PI_CODING_AGENT_DIR=<tmp> omp config set …` 落在 `<tmp>/config.yml`，真实 `~/.omp/agent/config.yml` 的 sha 与 mtime 都不变。所以把这个变量指向一个拷了真实 `config.yml` + `models.yml` 的临时目录，上面四条验收就能全在沙箱里跑；集成测试末尾再断言真实文件 sha/mtime 未变。

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

- [ ] 本机 `omp --mode rpc-ui` 可被插件拉起、关掉无僵尸
- [ ] 单个会话流式对话 + 工具卡片 + abort
- [ ] 附件：`＋` 选图与 `Cmd+V` 粘图都能发出去（jsonl 有 image part），用户气泡缩略图、点开预览、`Esc` 关闭
- [ ] 审批 confirm/select 闭环
- [ ] 两个会话同时跑，切走不 abort
- [ ] 面板与聊天区同屏：折叠按钮收起面板后聊天区占满、图标留在右上角能叫回来；放大镜点开才出过滤框（默认收起，收起即清过滤），按名称过滤；聊天列有 max-width 且居中；<480px 时面板覆盖、点行自动折叠
- [ ] 列表行悬停出置顶/完成两个图标、右键菜单能改名与归档、归档后行离开列表并收进列表底部的 `更多`（默认收起、展开可恢复）；历史会话恢复为新实例，同 jsonl 不双开
- [ ] Agent/Plan/Goal/Vibe 菜单：Plan 真能切进也能切回（换进程 + `--resume` 同一 jsonl），Goal/Vibe 禁用并写明原因
- [ ] 模型切换
- [ ] 子智能体只读进/出
- [ ] 计划只读进/出
- [ ] MCP 列表可见
- [ ] 设置页能改模型角色，`omp config get modelRoles` 读到新值
- [ ] 设置页能增删改自定义模型，`models.yml` 注释无损；非法配置不落盘
- [ ] 设置页五个分类分页显示，切分类不丢搜索词/展开行/未提交的表单；搜索只过滤当前分类，徽标数与空态跳转一致

质量：

- [ ] 关窗口无残留 omp
- [ ] 进程崩溃 Tab 显示 failed，可关
- [ ] webview 与 host 协议无 any 互发
- [ ] `rpc/types.ts` 标注对齐的 omp 版本

---

## 8. 风险

| 风险 | 影响 | 处理 |
|---|---|---|
| U2 迟迟不补（已确证：omp 18.0.11 / 18.2.8 / 上游 main 都没有） | Goal/Vibe 点不到；中会话切模式要换进程 | Plan 走 `--plan-yolo`；Goal/Vibe 菜单里如实禁用并写原因；上游补上 `set_mode` 后换回原地切，不留双轨 |
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
| 5.5 设置页 | 4–6 天 |
| **v1 合计** | **约 8–12 周** |
| 6 发布 | 另计 |

不含 OMP 上游 PR 的等待。U2 若必须自己做，另加 3–7 天（在 oh-my-pi 仓库）。

---

## 10. 下一步（本仓库之后）

1. 本机验证（已完成）：真实 stdout 记在 `docs/rpc-samples/`（`basic` / `chat` / `plan` / `edit` / `plan-yolo` 等）。两条结论定了后面的做法：`prompt("/plan")` **不是**模式开关，Plan 唯一的 headless 入口是 `--plan-yolo`。
2. 在 oh-my-pi 提 U1/U2/U3。
3. Phase 0 脚手架：`extension/package.json` + RpcClient。

未经用户改本文，不扩大范围（会话树、Hub 接管、SDK、ACP、MCP CRUD、`config.yml`/`models.yml` 的通用 YAML 编辑器）。
