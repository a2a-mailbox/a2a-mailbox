// mailbox-radar · 路徑、心跳、session 名冊（一個地方管，所有行程共用）
//
// 0.6.0 接入的兩個翻案（來自公司版 0.4.5，phase4b 決策 3a／3b）：
//   * data dir 收斂成單一固定路徑。舊版尊重 CLAUDE_PLUGIN_DATA，但桌面版給 `-inline`、
//     CLI 給 `-<marketplace>`，同一臺機器可能長出兩個平行宇宙（心跳／log／state 各一套），
//     開場警告讀到另一個宇宙的過期心跳就誤報。現在一律用 CANONICAL_DATA_DIR；
//     --data 與 MAILBOX_RADAR_DATA 只給測試與除錯覆寫。舊目錄留著不管、自然過期。
//     （Windows 實測：從 GitHub marketplace 安裝時兩個入口都給 `-a2a-mailbox`，
//       分裂只在本機路徑安裝時發生；收斂仍照做，當防禦。）
//   * 心跳改逐支 watcher 一檔（watchers/<session>.heartbeat.json）。舊版全 data dir 共用一檔，
//     任一支健康就遮住另一個對話 watcher 的死亡。現在「機器有沒有通知能力」＝任一檔新鮮，
//     「這個 session 的 watcher 活著嗎」＝看它自己那檔。投遞面不變（每對話一支、各投自己 socket）。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

// 機器層「通知器停」門檻：寬到筆電睡一下不誤報，窄到不讓人整個上午裸奔
export const STALE_MS = 10 * 60 * 1000;
// 單支 watcher 死亡門檻：它每 15 秒跳一次，2 分鐘沒跳＝死了（給睡眠喚醒一點餘裕）
export const SESSION_STALE_MS = 2 * 60 * 1000;

/** 分類器健康記號的檔名。寫的人（classify）與讀的人（inject）共用這一個定義，免得一邊改名另一邊靜默失效。 */
export const CLASSIFIER_HEALTH = 'classifier-health.json';

export const CANONICAL_DATA_DIR = join(homedir(), '.claude', 'plugins', 'data', 'mailbox-radar');

export function resolveDataDir(argv = process.argv) {
  const i = argv.indexOf('--data');
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  if (process.env.MAILBOX_RADAR_DATA) return process.env.MAILBOX_RADAR_DATA;
  return CANONICAL_DATA_DIR;
}

/** session id → 安全檔名片段（pid 檔與心跳檔共用同一套） */
export function sessionKey(sessionId) {
  return String(sessionId ?? 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
}

export function watchersDir(dataDir = resolveDataDir()) {
  return join(dataDir, 'watchers');
}

export function heartbeatPath(dataDir, sessionId) {
  return join(watchersDir(dataDir), `${sessionKey(sessionId)}.heartbeat.json`);
}

/** 讀出所有心跳檔：[{file, session, at, ageMs, pid, sock, ...}]，壞檔跳過 */
export function readHeartbeats(dataDir = resolveDataDir()) {
  const dir = watchersDir(dataDir);
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  const out = [];
  const now = Date.now();
  for (const f of names) {
    if (!f.endsWith('.heartbeat.json')) continue;
    try {
      const h = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      out.push({ file: f, session: f.replace(/\.heartbeat\.json$/, ''), ageMs: now - Date.parse(h.at), ...h });
    } catch {}
  }
  return out;
}

/**
 * 機器層通知器現況。
 * @returns {'alive'|'stale'|'never'}  alive＝至少一支 watcher 在 STALE_MS 內跳過；
 *   stale＝有心跳檔但全部過期；never＝這臺機器沒有任何心跳檔（headless／不支援的宿主本來就沒有，不警告）
 */
export function watcherStatus(dataDir = resolveDataDir()) {
  const hs = readHeartbeats(dataDir);
  if (hs.length === 0) return 'never';
  return hs.some((h) => h.ageMs <= STALE_MS) ? 'alive' : 'stale';
}

/** 單一 session 的 watcher 現況（門檻用 SESSION_STALE_MS）。 */
export function sessionWatcherStatus(dataDir, sessionId) {
  try {
    const h = JSON.parse(readFileSync(heartbeatPath(dataDir, sessionId), 'utf8'));
    return Date.now() - Date.parse(h.at) > SESSION_STALE_MS ? 'stale' : 'alive';
  } catch {
    return 'never';
  }
}

/**
 * 心跳是不是「別的版本的程式」寫的。常駐行程（watcher、桌鈴）不會跟著 plugin 更新重啟，
 * 更新後會一直跑舊版的程式：實測過舊版 watcher 不認得新掛的交換區，那條即時通知等於死掉，
 * 而且沒有任何錯誤。所以心跳記下自己的程式路徑（路徑裡帶版號），hook 每次順手比對，不同就換掉。
 * 心跳沒有 script 欄位＝還不會記路徑的舊版寫的，同樣算別的版本。
 * 心跳檔不存在或讀不到 → 回 false：無從判斷，交給原本的存活檢查。
 */
export function heartbeatFromOtherVersion(hbFile, scriptPath) {
  let h;
  try { h = JSON.parse(readFileSync(hbFile, 'utf8')); } catch { return false; }
  if (!h.script) return true;
  const norm = (x) => { const r = resolve(String(x)); return process.platform === 'win32' ? r.toLowerCase() : r; };
  return norm(h.script) !== norm(scriptPath);
}

// ── session 名冊：cross-session messaging 的通道 ────────────────────────────
// 每個開著的對話一條通道；對話結束 harness 會移除（watcher 靠這個判自己該退出）。
// 所以「有沒有活著的通道」＝「全機有沒有對話開著」。
//
// 兩個平台的通道長得不一樣：
//   macOS／Linux：Unix domain socket，是真檔案，住 /tmp/cc-socks/<pid>.sock，列目錄即可。
//   Windows：named pipe，路徑形如 \\.\pipe\LOCAL\cc-msg-<hash>，沒有目錄可 cd 進去，
//            但 \\.\pipe\ 本身可以 readdirSync 列舉（唯讀、不碰 server、零副作用）。

export const DEFAULT_SOCKET_DIR = '/tmp/cc-socks';
const WIN_PIPE_ROOT = '\\\\.\\pipe\\';
const WIN_PIPE_PREFIX = 'cc-msg-';

/** 名冊目錄候選（非 Windows）：固定的預設目錄＋（若有）本行程 socket 所在目錄，去重。
 *  不只看 env——桌鈴是由某個 hook 帶起的，繼承到的 SOCK 可能是測試假路徑或已退場 session 的路徑。 */
export function socketDirs() {
  if (process.platform === 'win32') return [];
  const s = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  const dirs = [DEFAULT_SOCKET_DIR];
  if (s && dirname(s) !== DEFAULT_SOCKET_DIR) dirs.push(dirname(s));
  return dirs;
}
export function socketDir() { return socketDirs()[0] ?? null; }

/**
 * 目前活著的 session 通道清單。找不到就回空陣列，不拋錯。
 * macOS／Linux：列所有候選目錄裡的 *.sock。
 * Windows：列舉 \\.\pipe\，挑 cc-msg- 開頭的（名字可能帶 LOCAL\ 前綴，兩種都收），
 *          回組回去的完整 pipe 路徑，可直接拿去 connect。
 */
export function liveSockets(dirs = socketDirs()) {
  const out = [];
  if (process.platform === 'win32') {
    try {
      for (const name of readdirSync(WIN_PIPE_ROOT)) {
        const leaf = name.replace(/\\/g, '/').split('/').pop();
        if (leaf && leaf.startsWith(WIN_PIPE_PREFIX)) out.push(WIN_PIPE_ROOT + name);
      }
    } catch {}
    return out;
  }
  for (const dir of Array.isArray(dirs) ? dirs : [dirs]) {
    try {
      for (const f of readdirSync(dir)) if (f.endsWith('.sock')) out.push(join(dir, f));
    } catch {}
  }
  return out;
}

/**
 * 某個通道路徑對應的 session 還活著嗎（null／空字串＝不知道，回 null）。
 * 兩個平台都直接 existsSync：Unix socket 是真檔案本來就行；Windows named pipe
 * 實測 existsSync 對活著的 pipe 回 true、對不存在的回 false，可用。
 * （0.5.x 曾以為 Windows 上 existsSync 對 pipe 永遠 false 而改走列舉整個 pipe 目錄，
 *   那是註解與實測脫節；列舉一次要掃八百多條 pipe，existsSync 一次系統呼叫就夠。）
 */
export function socketAlive(sock) {
  if (!sock) return null;
  return existsSync(sock);
}

/** 通道路徑 → 給人看的短名（兩平台通用，Windows 取 pipe 名、其他取檔名） */
export function socketLabel(sock) {
  if (!sock) return '';
  return basename(String(sock).replace(/\\/g, '/'));
}
