// team-mailbox-radar · session 狀態（節流帳與已告知帳）
//
// 存在 $CLAUDE_PLUGIN_DATA/sessions/<session_id>.json，一個 session 一檔。
// 存兩件事：
//   announced  這個 session 已經跟模型講過的檔名（開場注入那批算已講過）
//   lastScanAt 上次真的去掃交換區的時間（節流用）
// 為什麼要「已告知帳」：搭便車注入的職責是「session 進行中新落地的訊息」，
// 不是每次工具呼叫都把整個 backlog 再倒一次。

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const KEEP_DAYS = 7;

function dir(dataDir) {
  const d = join(dataDir, 'sessions');
  mkdirSync(d, { recursive: true });
  return d;
}

function file(dataDir, sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
  return join(dir(dataDir), `${safe}.json`);
}

// exchanges：這個 session 已經建過基準的交換區（預設交換區記成空字串）。
// 對話開著時才新掛上去的交換區不在裡面，搭便車會先替它建基準，而不是把它的舊檔整批當新落地。
// 舊狀態檔沒有這個欄位，回 null，由呼叫端當成「預設交換區建過」。
export function loadState(dataDir, sessionId) {
  try {
    const raw = readFileSync(file(dataDir, sessionId), 'utf8');
    const s = JSON.parse(raw);
    return {
      announced: new Set(s.announced ?? []),
      lastScanAt: s.lastScanAt ?? 0,
      exchanges: Array.isArray(s.exchanges) ? s.exchanges : null,
    };
  } catch {
    return { announced: new Set(), lastScanAt: 0, exchanges: null };
  }
}

export function saveState(dataDir, sessionId, state) {
  try {
    writeFileSync(file(dataDir, sessionId), JSON.stringify({
      announced: [...state.announced],
      lastScanAt: state.lastScanAt,
      exchanges: state.exchanges ?? null,
      updatedAt: new Date().toISOString(),
    }));
  } catch {
    // 寫不進去最差是下次重複講一次，不值得讓 hook 失敗
  }
}

/** 掃掉超過 KEEP_DAYS 天沒動的 session 檔，免得 data 目錄無限長大。 */
export function pruneState(dataDir, nowMs = Date.now()) {
  try {
    const d = dir(dataDir);
    for (const name of readdirSync(d)) {
      if (!name.endsWith('.json')) continue;
      const p = join(d, name);
      let updatedAt = 0;
      try { updatedAt = Date.parse(JSON.parse(readFileSync(p, 'utf8')).updatedAt ?? 0) || 0; } catch {}
      if (nowMs - updatedAt > KEEP_DAYS * 86400_000) rmSync(p, { force: true });
    }
  } catch {}
}

/**
 * watcher 每一輪的「新落地」判定。會把看過的 key 加進 seen，回傳這一輪該通知的項目。
 *
 * 三種情況只建基準、不通知：
 *   - 第一輪（first）：舊帳歸開場注入。
 *   - 已經看過的 key。
 *   - 這一輪才第一次出現的交換區裡「不追蹤」的檔（tracked === false）：收件匣交給其他系統追蹤時，
 *     那些檔永遠不進已讀帳，不建基準會整批倒出來。
 * 這一輪才第一次出現的交換區裡、雷達自己追的檔要通知：它會出現在 arrivals 就代表不在已讀帳，
 * 是還沒處理的信，不是歷史；而這個對話的開場注入沒涵蓋過這一區，這裡不報就沒人報。
 */
export function pickFresh(items, { seen, baselined, first }) {
  const fresh = [];
  for (const u of items) {
    const k = u.key ?? u.file;
    if (seen.has(k)) continue;
    seen.add(k);
    if (first) continue;
    if (baselined.has(u.exchangeId ?? '') || u.tracked !== false) fresh.push(u);
  }
  return fresh;
}
