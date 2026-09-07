#!/bin/sh
# noderun.sh — 幫 hook 找到 node 再執行（0.4.2 加入；0.5.1 起是兩個平臺唯一的進場路）。
#
# 為什麼需要：hooks.json 若直接寫 `node`，能不能跑取決於宿主 app 的 PATH 快照。
# macOS 桌面版 app 從 Dock 啟動時拿到的是 launchd 的精簡 PATH，不保證含使用者
# shell profile 加的路徑（Homebrew、~/.local/node）——所以一律經過本包裝器，
# 依序找常見安裝位置。
#
# 怎麼被呼叫（0.5.1）：hooks.json 用「shell 形式」（只有 command 字串、沒有 args）
# 寫 `sh noderun.sh …`。Claude Code 對 shell 形式在 macOS 用 sh -c、在 Windows 用
# Git Bash 執行；Git Bash 自帶 sh，PATH 承接使用者的完整 PATH（含 nodejs 目錄），
# 所以同一行在兩個平臺都走得通。舊版（0.5.0）用「執行檔形式」直接點名 `sh`，
# Windows 的 hook 行程 PATH 沒有 Git\bin，找不到 sh 會由 harness 印可見錯誤——
# 這就是改成 shell 形式的原因。Windows 前提：裝了 Git for Windows（安裝鏈本來就要 git）。
#
# 用法：sh noderun.sh <node 的參數...>（例：sh noderun.sh inject.mjs --event SessionStart）
for N in node /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.local/node/bin/node"; do
  if command -v "$N" >/dev/null 2>&1; then
    exec "$N" "$@"
  fi
done
# 找不到 node：對 stderr 講清楚（hook 日誌看得到），exit 127 讓失敗可見，
# 不靜默吞掉——與 Phase 1 task 6「偵測失敗要看得見」同一精神。
echo "mailbox-radar: 找不到 node（試過 PATH、/opt/homebrew/bin、/usr/local/bin、~/.local/node/bin）。請安裝 Node.js（Windows 用官方 MSI 並保持 Add to PATH 勾選）後重開 session。" >&2
exit 127
