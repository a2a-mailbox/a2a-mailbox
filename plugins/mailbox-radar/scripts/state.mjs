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

export function loadState(dataDir, sessionId) {
  try {
    const raw = readFileSync(file(dataDir, sessionId), 'utf8');
    const s = JSON.parse(raw);
    return { announced: new Set(s.announced ?? []), lastScanAt: s.lastScanAt ?? 0 };
  } catch {
    return { announced: new Set(), lastScanAt: 0 };
  }
}

export function saveState(dataDir, sessionId, state) {
  try {
    writeFileSync(file(dataDir, sessionId), JSON.stringify({
      announced: [...state.announced],
      lastScanAt: state.lastScanAt,
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
