// mailbox-radar · attention（0.7.6）：新訊息落地時，該叫醒哪個對話
//
// 0.7.5 以前：每個開著的對話各有一支 watcher，新訊息一落地全部各自叫醒自己的對話。
// 兩個問題：
//   ①做完收尾、不再使用的舊對話照樣被叫醒，在對話列表被推到最上面，使用者會把它誤認成剛開的新對話。
//   ②每叫醒一個對話就要整段重讀一次；閒置超過一小時的對話快取已過期，那一次特別貴，
//     而它偏偏是最不該被叫醒的那一種。
//
// 規則（兩行，定案）：
//   優先：每個專案資料夾裡，一小時內有人親手打字或新開的對話當中，最後動的那一個。
//   都沒有符合的：全部專案合起來，只叫醒最後動過的那一個對話（無人情境要有一個對話來處理）。
//
// 做法：hook 在「使用者送出訊息」與「對話開場」時記一筆活動時間；每支 watcher 發通知前
// 各自讀同一批檔案、各自算「是不是我」。大家看的是同一份資料、用同一條規則，所以不需要互相溝通。
// 沒被選中的對話不會漏信：PostToolUse 的注入本來就會在使用者回去動它的那一輪補報未讀。

import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sessionKey } from './paths.mjs';

/** 一小時：對齊 prompt cache 的有效時間——這段時間內動過的對話，叫醒它是便宜的那一種。 */
export const WARM_MS = 60 * 60 * 1000;

/** watcher 自己送進對話的通知開頭。這種「訊息」不是人打的，不算活動。 */
export const RADAR_PREFIX = '【交換區信箱・自動通知';

export function activityDir(dataDir) {
  return join(dataDir, 'activity');
}

export function activityPath(dataDir, sessionId) {
  return join(activityDir(dataDir), `${sessionKey(sessionId)}.json`);
}

/** 專案資料夾的比較鍵：正規化路徑；Windows 不分大小寫。空值回空字串（自成一組）。 */
export function projectKey(cwd) {
  if (!cwd) return '';
  const r = resolve(String(cwd)).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/**
 * 這則「提示」是不是宿主或別的程式產生的，而不是人打的（0.7.7）。
 * 實測（Claude Code 2.1.275）：背景指令結束時，宿主會排一則 <task-notification> 進對話，
 * 這條路也會觸發 UserPromptSubmit。不擋的話，任何會跑背景指令的對話都會一直被記成「有人在用」，
 * 剛好就是這套規則想排除的那種收尾後沒人碰的舊對話。
 * hook 的輸入沒有任何「這則提示從哪來」的欄位（官方文件確認過），只能看內容：
 *   ①以 XML 樣式標籤開頭（<task-notification>、<system-reminder>、<ci-monitor-event> 這一類宿主訊息）
 *   ②以宿主替跨對話訊息加的那行說明開頭（別的對話或 watcher 送來的，都不是這個對話的使用者打的）
 * 人打的訊息極少以標籤開頭；真的遇到，代價只是少記一筆活動，下一則訊息就補回來。
 */
const PEER_WRAPPER = 'Another Claude session sent a message:';
export function looksMachineMade(prompt) {
  const p = String(prompt ?? '').trimStart();
  if (/^<[A-Za-z][A-Za-z0-9_-]*[\s>/]/.test(p)) return true;
  return p.startsWith(PEER_WRAPPER);
}

/**
 * 這個 hook 事件算不算「人動了這個對話」。
 *   UserPromptSubmit：算，除非內容是雷達自己送的通知，或看起來是宿主／別的程式產生的（見 looksMachineMade）。
 *   SessionStart：新開、接續、清空、分岔都算；壓縮（compact）可能是自動發生的，不算。
 */
export function countsAsActivity(event, payload = {}) {
  if (event === 'UserPromptSubmit') {
    const p = typeof payload.prompt === 'string' ? payload.prompt : '';
    // 不用 startsWith：宿主會在別的對話或 watcher 送來的訊息前面加一行自己的說明
    // （實測對話紀錄裡是「Another Claude session sent a message:」），通知本文不在最開頭。
    // 這個事件對這類訊息會不會觸發、帶的是哪一種文字，官方文件沒寫，所以兩種都擋。
    const at = p.indexOf(RADAR_PREFIX);
    if (at >= 0 && at < 200) return false;
    return !looksMachineMade(p);
  }
  if (event === 'SessionStart') return payload.source !== 'compact';
  return false;
}

/** 記一筆活動。失敗不擋事（最壞情況是這個對話排序靠後）。 */
export function recordActivity(dataDir, sessionId, { cwd, kind, at = Date.now() } = {}) {
  try {
    mkdirSync(activityDir(dataDir), { recursive: true });
    writeFileSync(activityPath(dataDir, sessionId), JSON.stringify({
      session: sessionKey(sessionId), at: new Date(at).toISOString(), cwd: cwd ?? null, kind: kind ?? null,
    }));
    return true;
  } catch { return false; }
}

/** 讀出所有活動紀錄：Map<sessionKey, {at:number, cwd}>。壞檔跳過。 */
export function readActivities(dataDir) {
  const out = new Map();
  let names = [];
  try { names = readdirSync(activityDir(dataDir)); } catch { return out; }
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    try {
      const a = JSON.parse(readFileSync(join(activityDir(dataDir), f), 'utf8'));
      const at = Date.parse(a.at);
      if (Number.isFinite(at)) out.set(f.replace(/\.json$/, ''), { at, cwd: a.cwd ?? null });
    } catch {}
  }
  return out;
}

/** 清掉已經不在名冊上的對話留下的活動紀錄（對話結束後沒人會再讀它）。 */
export function sweepActivities(dataDir, liveKeys) {
  let names = [];
  try { names = readdirSync(activityDir(dataDir)); } catch { return 0; }
  let n = 0;
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    if (liveKeys.has(f.replace(/\.json$/, ''))) continue;
    try { unlinkSync(join(activityDir(dataDir), f)); n += 1; } catch {}
  }
  return n;
}

// 同一時刻的排序要有定論，否則兩支 watcher 可能各自認為是自己（或都認為不是）。
const later = (a, b) => (a.at !== b.at ? a.at > b.at : a.session > b.session);

/**
 * 純函式：這一輪該不該由「我」發通知。
 * @param {string} me  我的 sessionKey
 * @param {Array<{session:string, at:number|null, cwd:string|null, startedAt?:number|null}>} sessions
 *        這臺機器上活著、叫得醒的對話（含我）。at＝最後一次人為活動；沒紀錄給 null。
 * @returns {{notify:boolean, rule:'warm'|'fallback'|'solo', winner:string|null}}
 */
export function chooseNotified(me, sessions, { now = Date.now(), warmMs = WARM_MS } = {}) {
  const all = sessions.some((s) => s.session === me) ? sessions : [...sessions, { session: me, at: null, cwd: null }];
  if (all.length === 1) return { notify: true, rule: 'solo', winner: me };

  const warm = all.filter((s) => s.at != null && now - s.at <= warmMs && now - s.at >= -60_000);
  if (warm.length > 0) {
    const mine = warm.find((s) => s.session === me);
    if (!mine) return { notify: false, rule: 'warm', winner: null };
    const group = warm.filter((s) => projectKey(s.cwd) === projectKey(mine.cwd));
    const top = group.reduce((a, b) => (later(b, a) ? b : a));
    return { notify: top.session === me, rule: 'warm', winner: top.session };
  }

  // 沒有任何對話一小時內有人動過：全機只選一個。沒有活動紀錄的（升級前就開著的對話）
  // 退而用 watcher 的啟動時刻排序，再沒有就當 0。
  const ranked = all.map((s) => ({ session: s.session, at: s.at ?? s.startedAt ?? 0 }));
  const top = ranked.reduce((a, b) => (later(b, a) ? b : a));
  return { notify: top.session === me, rule: 'fallback', winner: top.session };
}
