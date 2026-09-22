#!/usr/bin/env bash
# 一键打包 omp-studio.vsix 并安装到本地 VS Code。
set -euo pipefail
cd "$(dirname "$0")/extension"

# 打包（typecheck + esbuild --production + vsce package，--allow-missing-repository/--skip-license 免交互确认）
npm run package

# 安装：优先 PATH 上的 CLI，其次常见应用名/常见目录里找应用自带的 bin CLI
# （macOS 上应用常改了名，比如 /Applications/VSCode.app，CLI 不在 PATH）
find_app_cli() {
	local app_dirs=("/Applications" "$HOME/Applications")
	local names=(
		"Visual Studio Code.app" "VSCode.app" "Visual Studio Code - Insiders.app"
		"VSCodium.app" "Cursor.app" "Windsurf.app"
	)
	for dir in "${app_dirs[@]}"; do
		for name in "${names[@]}"; do
			local bin
			for bin in "bin/code" "bin/codium" "Contents/Resources/app/bin/code" "Contents/Resources/app/bin/codium"; do
				local candidate="$dir/$name/$bin"
				if [ -x "$candidate" ]; then
					printf '%s' "$candidate"
					return 0
				fi
			done
		done
	done
	return 1
}

cli=()
if command -v code >/dev/null 2>&1; then
	cli=(code)
elif command -v codium >/dev/null 2>&1; then
	cli=(codium)
elif command -v code-server >/dev/null 2>&1; then
	cli=(code-server)
elif candidate="$(find_app_cli)"; then
	cli=("$candidate")
fi

if [ "${#cli[@]}" -eq 0 ]; then
	echo "错误: 未找到 code/codium/code-server CLI，也没在 /Applications 找到 VS Code 系应用，无法安装" >&2
	exit 1
fi

echo "安装 ${cli[0]} --install-extension omp-studio.vsix --force"
"${cli[@]}" --install-extension omp-studio.vsix --force
echo "完成。重载 VS Code 窗口后生效。"
