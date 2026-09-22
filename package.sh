#!/usr/bin/env bash
# 一键打包 omp-studio.vsix 并安装到本地 VS Code。
set -euo pipefail
cd "$(dirname "$0")/extension"

# 打包（typecheck + esbuild --production + vsce package）
npm run package

# 安装：优先 VS Code CLI，其次 VSCodium / code-server
if command -v code >/dev/null 2>&1; then
	cli=(code)
elif command -v codium >/dev/null 2>&1; then
	cli=(codium)
elif command -v code-server >/dev/null 2>&1; then
	cli=(code-server)
else
	echo "错误: 未找到 code/codium/code-server CLI，无法安装" >&2
	exit 1
fi

echo "安装 ${cli[0]} --install-extension omp-studio.vsix --force"
"${cli[@]}" --install-extension omp-studio.vsix --force
echo "完成。重载 VS Code 窗口后生效。"
