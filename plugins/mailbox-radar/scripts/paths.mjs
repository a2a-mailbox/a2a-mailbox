// team-mailbox-radar · 路徑與心跳（一個地方管 dataDir，三種行程共用）
//
// 三種行程拿 CLAUDE_PLUGIN_DATA 的能力不同（2026-08-26 實測）：
//   hook（inject.mjs）      → 環境變數有
//   monitor（monitor.mjs）  → 環境變數沒有，靠 monitors.json 的佔位符代換以 --data 傳入
//   statusLine              → 不是 plugin 元件（user settings 的 command），什麼都沒有
// 所以最後一層 fallback 寫死本部署的固定慣例：<plugin>-<marketplace>。

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

// 心跳過期門檻：寬到筆電睡一下不誤報，窄到不讓人整個上午裸奔
export const STALE_MS = 10 * 60 * 1000;

export function resolveDataDir(argv = process.argv) {
  const i = argv.indexOf('--data');
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  if (process.env.CLAUDE_PLUGIN_DATA) return process.env.CLAUDE_PLUGIN_DATA;
  return join(homedir(), '.claude', 'plugins', 'data', 'mailbox-radar-a2a-mailbox');
}

/**
 * session 收件通道還活著嗎（watcher 的生命週期綁定）。
 * mac／Linux：通道是 Unix domain socket，是真檔案，existsSync 可靠。
 * Windows：通道是 named pipe（\\.\pipe\...），existsSync 對它永遠 false——
 * 改列舉 pipe 目錄比對名稱（唯讀、不碰 server、零副作用）。
 * 列舉本身拋錯＝暫態失敗，視為 alive（fail-open）：誤殺的代價是喚醒層靜默消失，
 * 比多活幾輪貴；真死掉還有「連續投遞失敗」的後備退出兜著（watcher.mjs）。
 */
export function socketAlive(sock) {
  if (!sock) return false;
  if (process.platform !== 'win32') return existsSync(sock);
  try {
    const name = basename(sock.replace(/\\/g, '/'));
    return readdirSync('\\\\.\\pipe\\').some((p) => p === name || p.endsWith(name));
  } catch {
    return true;
  }
}

/**
 * 通知器（watcher/monitor）現況。
 * @returns {'alive'|'stale'|'never'} never＝這臺機器從沒跑過 monitor（不警告，
 *   因為 headless／不支援 monitor 的宿主本來就沒有；可見性退回 Phase 1 層級）
 */
export function watcherStatus(dataDir = resolveDataDir()) {
  try {
    const h = JSON.parse(readFileSync(join(dataDir, 'watcher-heartbeat.json'), 'utf8'));
    const age = Date.now() - Date.parse(h.at);
    return age > STALE_MS ? 'stale' : 'alive';
  } catch {
    return 'never';
  }
}
