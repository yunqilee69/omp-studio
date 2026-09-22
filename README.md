# OMP Studio

VS Code 侧栏控制面，面向已经在用 [omp](https://omp.sh) 的人。

把终端里的多会话、模式、模型、MCP、子智能体输出，接到编辑器侧栏。不重新实现一套 agent。

```
VS Code 侧栏
  Sessions 列表 ──1:1── omp --mode rpc 子进程 ── ~/.omp/agent/sessions/...
```

产品决策、分阶段计划与验收标准见 [`docs/dev-plan.md`](docs/dev-plan.md)；实现约束见 [`AGENTS.md`](AGENTS.md)。

## 安装与运行

要求：本机已装 `omp`（能跑 `omp --mode rpc`）、VS Code 1.100+。

```bash
cd extension
npm install
npm run build          # 产出 dist/extension.js、dist/webview.js、dist/webview.css
npm run package        # 产出 omp-studio.vsix
code --install-extension omp-studio.vsix
```

开发调试：用 VS Code 打开仓库，按 F5 启动 Extension Development Host，侧栏出现 OMP Studio 图标。

## 用法

侧栏进入就是 **Sessions 列表**：这次运行中的会话，一行一个 `omp --mode rpc` 进程。行首圆点和状态文字说明它此刻在干什么（`运行中` / `空闲` / `已停止`）。点一行进详情，详情顶部 `←` 回列表（进程继续跑）。列表底部输入框发送 = 新建实例 + 发这条 prompt，一步进详情。以前落盘、没有实例打开的会话就在同一张列表里（文件行），页头过滤框按名称筛；选一行 = 新实例 + `--resume <path>`。行内不常驻按钮：悬停出 `置顶` / `完成` 两个图标，其余操作在行的右键菜单里。

| 操作 | 位置 |
|---|---|
| 新建会话并发送 | 列表底部输入框，Enter |
| 搜索 / 找回以前的会话 | 列表页头过滤框（标题子串，大小写不敏感；同列表里的文件行就是以前落盘的会话） |
| 置顶 / 取消置顶 | 列表行悬停的 `置顶` 图标，或行右键菜单（按 jsonl 记住顺序） |
| 标记完成（归档） | 列表行悬停的 `完成` 图标，或行右键菜单。归档的行移出列表，行上方 `已归档 N 个 · 显示` 可召回；归档实例行会先停掉它的进程 |
| 重命名会话 | 行右键菜单「重命名…」（作用于这一行的实例，不必先切过去） |
| 新建空实例 | 命令面板 `New Instance`，结果出现在列表里 |
| 回会话列表 | 详情顶部 `←`，或命令面板 `Open Session…` |
| 复制会话名称 / 文件路径 | 行右键菜单（走宿主的剪贴板） |
| 关闭会话（结束它的进程） | 行右键菜单「关闭会话」 |
| 切换模型 | 输入框上方模型选择 |
| 改并发实例上限 | 设置页 → `扩展`（也可以直接改 `settings.json` 里的 `ompStudio.maxInstances`） |
| 切 thinking 档位 | 模型旁的 thinking 按钮 |
| 打开子智能体输出 / 计划正文 | 对应卡片或按钮；当前会话整页替换对话，顶部返回 |
| 中止当前一轮 | 发送后输入框旁「中止」；Esc 同样中止。结束后可再发 |
| MCP 列表与开关 | 侧栏 MCP 面板 |
| 工具审批 | 弹出卡片里选择/确认；点忽略等于 `cancelled` |

设置项（`settings.json`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `ompStudio.ompPath` | `omp` | omp 可执行文件，PATH 名或绝对路径 |
| `ompStudio.maxInstances` | `4` | 同时运行实例软上限；超出只警告，不阻止。也可在设置页「扩展」里改（写的是同一个键） |
| `ompStudio.approvalMode` | `inherit` | `inherit` 不加参数，沿用 omp 自己的 `tools.approvalMode` |

诊断：命令面板 `OMP Studio: Diagnose`，输出 omp 路径、版本、会话目录与协议能力。

## 边界（有意不做）

- 会话树、`/branch`、同文件多叶
- 接管子智能体（steer / revive / kill），子智能体视图只读
- attach 终端里正在跑的 `omp`：各写各的 jsonl
- 两个实例打开同一份 session jsonl
- 嵌入 OMP SDK（SDK 需要 Bun，扩展宿主是 Node）
- 完整 `models.yml` / MCP OAuth 编辑器

## 上游缺口

omp 18.1.2 的 RPC 没有 `list_sessions`、`set_mode`、`get_mcp_servers`。当前降级方案与证据见
[`docs/upstream-issues.md`](docs/upstream-issues.md)。

## 测试

```bash
cd extension
npm test                 # 单元测试：帧解码、会话文件、转录重建、local:// 计划解析
npm run test:integration # 真实 omp 进程：多会话并行、进程回收（需要本机 omp）
npm run package          # typecheck + 生产构建 + .vsix
```

侧栏 UI 用真实 `omp --mode rpc` 录制的 host 消息回放到内置 webview（不是 mock DOM）；设置页用真实
`SettingsService` 读出的快照回放（在临时 agent 目录里跑，不动本机 `models.db`）：

```bash
cd extension
npm run build
node scripts/record-ui-log.mjs             # 写出 test/ui/host-log*.json（侧栏）
node scripts/record-settings-snapshot.mjs  # 写出 test/ui/settings-snapshot.json（设置页）
python3 -m http.server 8765                # /test/ui/harness.html、/test/ui/settings-harness.html
```

设置页的写入链路（命令 → panel → `SettingsService` → VS Code 配置）只在 VS Code 里跑得起来，所以用
stub 掉 `vscode` 的真实 `activate()` 驱动一遍并断言：

```bash
node scripts/check-settings-panel.mjs      # 改并发上限 → ompStudio.maxInstances；越界/未知键被拒
```
