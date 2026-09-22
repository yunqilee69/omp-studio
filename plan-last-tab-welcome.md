# 关最后一个会话后回到欢迎页

记录日期：2026-09-22。本文是实现方案，不是产品源；产品决策仍以 `docs/dev-plan.md` 为准。实现时按本文改代码，并在 `docs/dev-plan.md` §1.3 补一句口径。

## 问题

只有一个会话时关掉它，侧栏应显示欢迎页（`renderHero`：标题 +「新建实例」+「打开历史会话」），而不是继续画已关掉会话的 transcript / composer。

`renderBody` 的空态门是对的：

```ts
if (view.id === undefined || state === undefined) {
	viewHeader.classList.add("hidden");
	composer.classList.add("hidden");
	renderHero();
	return;
}
```

但关最后 Tab 时这条路径走不到。

Host：`InstanceManager.close` 在 map 空时把 `activeId` 置 `undefined`，再 `emit("active")` → `pushSession()`。无 active 时只发空 `tabs`，**不拆掉当前 session 快照**：

```ts
private pushSession(): void {
	const instance = this.manager.active;
	if (!instance) {
		this.post({ type: "tabs", tabs: this.tabs(), activeId: undefined });
		return;
	}
	// ...
}
```

Webview：`tabs` 只改条、不改 body：

```ts
case "tabs":
	view.tabs = message.tabs;
	view.activeId = message.activeId;
	renderTabs();
	return;
```

结果：Tab 条只剩 `+`，`view.id` / `view.state` / `view.items` 仍是已关 Tab，composer 和记录还在。

次要竞态：`close` 先从 map 删掉再 `await instance.dispose()`。dispose 的 `settleStreaming` 仍会 `emit("items")`，sidebar 无条件转发。即便先清了 UI，迟到的 `items` 也能把幽灵记录画回来（`items` 只比对 `view.id`）。

## 产品口径

关最后一枚 Tab = 停该进程 + 显示欢迎页。**不**自动 `tab/new`。`+` / 打开历史才再开实例。

实现时写进 `docs/dev-plan.md` §1.3「关 Tab」行。

## 决策

Host 与 webview 都把「无 active Tab」当成完整空态，不只改 Tab 条。

不新增 `idle` 消息：`session` 已是「当前 Tab 全量快照」，无 Tab 就是这份快照的空值。`tabs` 仍是条；body 必须由 session 空快照或 `tabs.activeId === undefined` 清掉。

不自动建 Tab。失败面板关掉后同样回欢迎页，不要停在「这个 Tab 的 omp 已停止」。

## 改动

### 1. 协议 `extension/src/shared/protocol.ts`

`session` 增加无 Tab 变体（`id` 缺省）：

```ts
| { type: "session"; id: string; state: InstanceState; stack: ViewLayer[]; items: Item[]; models?: ModelChoice[]; commands?: SlashCommandView[] }
| { type: "session"; id?: undefined }
```

### 2. Host `extension/src/providers/sidebar.ts`

- `pushSession` 无 active：发空 `tabs` **并且** `{ type: "session" }`（无 `id`）。
- `items` / `ui`：实例已不在 map 里则丢弃，避免 dispose 回放幽灵记录。

### 3. Webview `extension/webview/main.ts`

抽出 `clearActiveSession()`：

- `view.id` / `view.state` = `undefined`
- `stack/items/models/commands` 清空
- 关掉 tab 作用域 overlay（`model` / `ui`）；`history` / `mcp` 是工作区级，可留
- `itemElements.clear()`，然后 `renderBody()` → hero

触发：

- `session` 且 `message.id` 缺省
- `tabs` 且 `activeId === undefined`（防御：只靠现有空 `tabs` 也能回 hero）

有 `id` 的 `session` 保持现状。`session` 里 `renderBody()` 后再 `renderItems(message.items)` 在空态会把 hero 盖掉——空会话路径禁止再 `renderItems`。

### 4. 产品计划 `docs/dev-plan.md`

§1.3 关 Tab 行补一句：最后一枚 Tab 关掉后显示欢迎页，不自动新建。

## 不改

- 关非最后 Tab：仍切到 `remaining` 最后一个，推那个 `session`
- `counter` 不重置（下一枚仍是 `tab-N+1`）
- 不改进程 kill / jsonl 占用锁
- 不把失败 Tab 假装成欢迎页——失败 Tab 还在 map 里时继续失败面板；关掉才 hero

## 验证

1. 纯函数单测（webview 无 DOM 测试）：`clearActiveSession` / `session` 空变体应用后 `id/state` 为空、items 空。可把 reducer 抽到 `extension/webview/session-view.ts` 或 `extension/src/shared/empty-session.ts`，`extension/test/unit/` 覆盖：
   - 有会话 → 空 `session` → 应显示 hero
   - 空 `tabs`（`activeId` undefined）→ 同样
   - 迟到 `items`（旧 tab id）在清空后忽略
   - 关非最后 Tab（仍有 `activeId`）不清空
2. `npm --prefix extension test`
3. 手测：单 Tab 聊几句 → × → hero + 无 composer；`+` 新空会话；失败 Tab 关掉同样 hero。两 Tab 关一个，另一个 transcript 仍在。
