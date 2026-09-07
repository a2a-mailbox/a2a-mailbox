// team-mailbox-radar · 健康帳（偵測失敗的可見性，Phase 1 task 6）
//
// 為什麼存在：偵測器對錯誤原本一律靜默退場（注入是加分項，不該吵）。但實際發生過
// 「macOS 完整磁碟取用權沒授權 → 整棵 Drive 讀不到 → 雷達整個死掉而使用者不知道」。
// 讀不到信箱是「唯一真相」失效，不能無聲。
//
// 只管 errorKind 'scan'（有裝但讀不到交換區）；'config'（根本沒裝 team-mailbox）
// 不進健康帳，由呼叫端先行分流。
// 介面：FAIL_THRESHOLD / loadHealth / recordFailure / recordSuccess / formatWarning。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// 門檻 2：單次失敗不報（Drive 掛載偶發抖動很常見），連續第 2 次就要讓人知道
export const FAIL_THRESHOLD = 2;

function file(dataDir) {
  return join(dataDir, 'health.json');
}

export function loadHealth(dataDir) {
  try {
    const h = JSON.parse(readFileSync(file(dataDir), 'utf8'));
    return {
      consecutiveFailures: h.consecutiveFailures ?? 0,
      lastError: h.lastError ?? null,
      since: h.since ?? null,
    };
  } catch {
    return { consecutiveFailures: 0, lastError: null, since: null };
  }
}

function save(dataDir, h) {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file(dataDir), JSON.stringify(h));
  } catch {
    // 健康帳寫不進去就算了，不能反過來把 hook 弄掛
  }
}

/** 記一次失敗，回傳更新後的健康帳。 */
export function recordFailure(dataDir, error) {
  const h = loadHealth(dataDir);
  const updated = {
    consecutiveFailures: h.consecutiveFailures + 1,
    lastError: String(error ?? '未知錯誤'),
    since: h.since ?? new Date().toISOString(),
  };
  save(dataDir, updated);
  return updated;
}

/** 記一次成功。歸零只在原本有失敗紀錄時寫檔——成功路徑不多付一次寫入。 */
export function recordSuccess(dataDir) {
  const h = loadHealth(dataDir);
  if (h.consecutiveFailures > 0) {
    save(dataDir, { consecutiveFailures: 0, lastError: null, since: null });
  }
}

/** 達門檻回警告文字，未達門檻回 null（呼叫端只在 truthy 時 emit）。 */
export function formatWarning(h) {
  if (!h || h.consecutiveFailures < FAIL_THRESHOLD) return null;
  const since = h.since ? h.since.slice(0, 16).replace('T', ' ') + ' UTC' : '不明時間';
  return [
    `【交換區信箱】⚠️ 信箱雷達讀不到交換區，已連續失敗 ${h.consecutiveFailures} 次（自 ${since} 起）。`,
    `最後一次的錯誤：${h.lastError ?? '未知錯誤'}`,
    '',
    '這代表新訊息現在偵測不到，不是沒有訊息。請在這一輪回應裡用一句話告訴使用者這件事。',
    process.platform === 'win32'
      ? '常見原因：Google Drive 桌面版沒在跑、串流碟未掛載（檔案總管看不到 Drive 磁碟）、或交換區路徑（team-mailbox 的 config.md）不對。'
      : '常見原因：macOS 完整磁碟取用權沒授權給這個 app（系統設定 → 隱私權與安全性 → 完整磁碟取用權，加入後打開開關）、Google Drive 桌面版沒在跑、或交換區路徑（team-mailbox 的 config.md）不對。',
  ].join('\n');
}
