# OMP Studio

VS Code 侧栏控制面，面向已经在用 [omp](https://omp.sh) 的人。

把终端里的多会话、模式、模型、MCP、子智能体输出，接到编辑器侧栏。不重新实现一套 agent。

```
VS Code 侧栏
  Tab 实例 ──1:1── omp --mode rpc 子进程 ── ~/.omp/agent/sessions/...
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

侧栏顶部是 Tab 条：`+` 新建实例，时钟图标打开历史会话。

| 操作 | 位置 |
|---|---|
| 新建实例（新 `omp --mode rpc` 进程） | Tab 条 `+`，或命令面板 `New Instance` |
| 打开历史会话 | Tab 条时钟图标，或 `Open Session…` |
| 切换模型 | 输入框上方模型选择 |
| 切 thinking 档位 | 模型旁的 thinking 按钮 |
| 打开子智能体输出 / 计划正文 | 对应卡片或按钮；当前 Tab 整页替换对话，顶部返回 |
| 中止当前一轮 | 发送后输入框旁「中止」；Esc 同样中止。结束后可再发 |
| MCP 列表与开关 | 侧栏 MCP 面板 |
| 工具审批 | 弹出卡片里选择/确认；点忽略等于 `cancelled` |

设置项（`settings.json`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `ompStudio.ompPath` | `omp` | omp 可执行文件，PATH 名或绝对路径 |
| `ompStudio.maxInstances` | `4` | 同时运行实例软上限；超出只警告，不阻止 |
| `ompStudio.approvalMode` | `inherit` | `inherit` 不加参数，沿用 omp 自己的 `tools.approvalMode` |

诊断：命令面板 `OMP Studio: Diagnose`，输出 omp 路径、版本、会话目录与协议能力。

## 边界（有意不做）

- 会话树、`/branch`、同文件多叶
- 接管子智能体（steer / revive / kill），子智能体视图只读
- attach 终端里正在跑的 `omp`：各写各的 jsonl
- 两个 Tab 打开同一份 session jsonl
- 嵌入 OMP SDK（SDK 需要 Bun，扩展宿主是 Node）
- 完整 `models.yml` / MCP OAuth 编辑器

## 上游缺口

omp 18.1.2 的 RPC 没有 `list_sessions`、`set_mode`、`get_mcp_servers`。当前降级方案与证据见
[`docs/upstream-issues.md`](docs/upstream-issues.md)。

## 测试

```bash
cd extension
npm test                 # 单元测试：帧解码、会话文件、转录重建、local:// 计划解析
npm run test:integration # 真实 omp 进程：多 Tab 并行、进程回收（需要本机 omp）
npm run package          # typecheck + 生产构建 + .vsix
```

侧栏 UI 用真实 `omp --mode rpc` 录制的 host 消息回放到内置 webview（不是 mock DOM）：

```bash
cd extension
node scripts/record-ui-log.mjs   # 写出 test/ui/host-log*.json
python3 -m http.server 8765      # 打开 /test/ui/harness.html
```
