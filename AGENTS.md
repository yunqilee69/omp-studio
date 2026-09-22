# AGENTS.md

OMP Studio 是 VS Code 侧栏控制面：把本机 `omp` 的多实例会话、模式、模型、MCP、子智能体只读输出接到编辑器。本文件约束实现，不是第二份产品说明。产品与阶段验收以 [`docs/dev-plan.md`](docs/dev-plan.md) 为准。

## 定位

- 宿主，不是第二套 OMP。逻辑在 `omp --mode rpc` 里；插件只管进程、RPC、侧栏 UI。
- 不 bundle `@oh-my-pi/pi-coding-agent`，不在 extension host 里 `createAgentSession`。SDK 要 Bun，VS Code 是 Node。
- 不走 ACP 做主路径。ACP 是公约数，带不出模式/MCP/子智能体视图栈。

## 已锁定的产品决策

1. **会话 = 并发实例**。侧栏列表里每一行对应一个 `omp --mode rpc` 子进程。切会话不断进程。
2. **不做会话树**。`/tree`、`/branch`、同文件多叶不是需求。
3. **视图栈**：子智能体输出、计划正文在当前会话整页替换对话，顶上返回。不分栏、不新开会话。
4. **子智能体只读**。无输入框、不 `hub send`、不 revive/steer/kill。
5. **模式**是 `none | plan | goal | vibe`，不是换 scout/reviewer。
6. **不 attach** 终端里正在跑的 `omp`。各写各的 jsonl。
7. 两个会话**禁止**打开同一份 session jsonl。
8. **设置页在编辑器区**（`WebviewPanel`，布局照 VS Code 设置页），不是侧栏弹窗。v1 编辑模型角色（`config.yml` 的 `modelRoles`）与自定义模型（`models.yml`）的结构化表单。

改以上任一条，先改 `docs/dev-plan.md`，再改代码。

## 布局（目标，按计划阶段创建）

```
docs/dev-plan.md          唯一产品+阶段源
extension/                VS Code 插件（Phase 0 起）
  package.json
  src/                    extension host
  webview/                webview UI：侧栏 + 编辑器区设置页（两个入口）
  test/                   单测；真实录制输出放 test/fixtures 或 docs/rpc-samples
```

未到对应阶段不要提前建空壳源码。

## 协议

- 传输：`omp --mode rpc`，JSONL，优先协商 protocol v2。
- 进程：`cwd` = 当前工作区根。显式 `--resume <path>` 才打开历史会话。
- `prompt` 的 success 只是 ack。主会话完成看 `agent_end` 且 `isTerminal !== false`。
- 缺的 RPC（`list_sessions`、`set_mode`、MCP list）记在计划「上游缺口」。缺口未补时允许文档写明的降级，禁止 silently 扫盘当长期方案。

## 代码

- TypeScript strict。extension host 与 webview 通过 typed message 通信，协议单文件维护。
- 一个 Instance 拥有一个 child process + 一份 view stack。进程死了会话必须可见失败，禁止假装还在聊。
- 工具审批必须接 `extension_ui_request`。做不到就明确 yolo，不要卡死。
- 不做 OMP 配置文件的通用编辑器。`config.yml` 一律走 `omp config set`，插件永不直接写它；`mcp.json` 只列表、切换、跳到文件，插件永不写它。只有 `models.yml` 由设置页的结构化表单写（唯一例外，因为 omp 没有任何写它的命令），且必须保注释、写前用真 omp 在临时 agent 目录里校验、原子写 + 备份。

## 验证

- 行为改动用真实 `omp --mode rpc` 或录制的 JSONL fixture，不拿 mock 冒充协议。
- 多会话验收：两个实例同时 `prompt`，切走的那个必须继续跑完。
- 不要跑与本仓库无关的全仓测试。
