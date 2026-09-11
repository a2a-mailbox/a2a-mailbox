#!/usr/bin/env node
// mailbox-radar · 桌鈴（deskbell）
//
// 解什麼：推播只能投給活著的 session 通道——全機沒有任何對話開著時，訊息落地沒人知道，
// 人要到下次開 Claude 才看到。桌鈴補這個洞：一支**不綁通道、不隨 session 退出**的常駐小行程，
// 在「全機沒有活通道」時對未讀訊息發系統通知橫幅；有任何對話開著就閉嘴（那是 watcher 的事，不雙響）。
//
// 行為：
//   * 每輪讀 config.md 的「桌鈴：開／關」（預設開；關＝待命不響，改回開即生效，不用重開）
//   * 一封訊息第一次看到響一次；之後只要它還未讀、且全機仍無對話，每 REPEAT_MS（60 分鐘）再響一次
//     （橫幅幾秒就自己收起，重複提醒取代「請每臺機器改 Alert 樣式」）
//   * 內容只含檔名 metadata（誰、主旨、幾筆），跟 watcher 通知同一慣例
//   * 由 inject.mjs 的 ensureDeskbell 帶起（全機單例，pid 檔＋心跳），活到關機或休眠；重開機後第一次開 Claude 又會被帶起
//
// 平台：目前只有 macOS 實作（osascript 橫幅）。Windows 上這支會在啟動時直接退出並記一行 log，
// 系統通知（PowerShell toast）是另開的任務，做好前 Windows 使用者只有 watcher 喚醒、沒有離席提醒。
//
// 用法：node deskbell.mjs [--data <dir>]

import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { detect } from './detect.mjs';
import { liveSockets, resolveDataDir } from './paths.mjs';
import { configPath as defaultConfigPath } from './userdata.mjs';

export const POLL_MS = 60_000;
export const REPEAT_MS = 60 * 60 * 1000;
const dataDir = resolveDataDir();
const STATE = join(dataDir, 'deskbell-state.json');
const HB = join(dataDir, 'deskbell.heartbeat.json');

function log(line) {
  try { mkdirSync(dataDir, { recursive: true }); appendFileSync(join(dataDir, 'deskbell.log'), `${new Date().toISOString()}  ${line}\n`); } catch {}
}
function heartbeat(extra = {}) {
  try { mkdirSync(dataDir, { recursive: true }); writeFileSync(HB, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, pollMs: POLL_MS, ...extra })); } catch {}
}
process.on('SIGTERM', () => { log('收到 SIGTERM，桌鈴退出'); process.exit(0); });

/** config.md 的「桌鈴」開關；沒寫＝開。config 位置走 userdata.mjs，跟其他腳本同一套。 */
export function bellEnabled(configPath = process.env.MAILBOX_RADAR_CONFIG || defaultConfigPath()) {
  try {
    const m = readFileSync(configPath, 'utf8').match(/^桌鈴\s*[：:]\s*(.+)$/m);
    if (!m) return true;
    return !/^(關|off|false|0|否)$/i.test(m[1].trim());
  } catch { return true; }
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return { notified: {} }; }
}
function saveState(s) { try { writeFileSync(STATE, JSON.stringify(s)); } catch {} }

/** 發一則 macOS 橫幅。回 true/false。 */
export function notify(title, body, { sound = 'Glass' } = {}) {
  const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}${sound ? ` sound name ${JSON.stringify(sound)}` : ''}`;
  const r = spawnSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 10_000 });
  if (r.status !== 0) log(`notify 失敗 exit=${r.status} ${String(r.stderr || '').trim()}`);
  return r.status === 0;
}

/**
 * 決定這一輪要不要響、響什麼。純函式，測試用。
 *
 * items 是 detect 的 arrivals：每一項帶 tracked。沒帶 tracked 的一律當成追蹤（舊呼叫端相容）。
 *   追蹤中的（預設全部）：第一次看到響一次，之後仍未讀就每 repeatMs 再響。
 *   不追蹤的（收件匣交給其他系統時的收件匣）：只在落地時響一次，永不重響——
 *     那邊處理掉的訊息永遠不會進已讀帳，重響就會為已經有人在管的東西每小時吵一次。
 *
 * 第一次跑（state.seeded 還沒設）時，不追蹤的那些只建基準、不響。它們永遠不會進已讀帳，
 * 沒有基準的話，第一輪會把整個收件匣歷史當成新到的一次倒出來。追蹤中的維持原本行為。
 */
export function plan(items, state, now, { repeatMs = REPEAT_MS } = {}) {
  const notified = state.notified ?? {};
  const isTracked = (u) => u.tracked !== false;
  const present = new Set(items.map((u) => u.file));
  for (const f of Object.keys(notified)) if (!present.has(f)) delete notified[f]; // 已讀掉（或檔案消失）的忘記
  if (!state.seeded) {
    for (const u of items) if (!isTracked(u) && !(u.file in notified)) notified[u.file] = now;
  }
  const fresh = items.filter((u) => !(u.file in notified));
  const due = items.filter((u) => isTracked(u) && u.file in notified && now - notified[u.file] >= repeatMs);
  const ring = [...fresh, ...due];
  for (const u of ring) notified[u.file] = now;
  const freshUntracked = fresh.filter((u) => !isTracked(u)).length;
  return { ring, fresh: fresh.length, due: due.length, freshUntracked, state: { notified, seeded: true } };
}

function describe(items) {
  const lines = items.slice(0, 2).map((u) => `${u.type}：${u.from ? u.from + ' → ' : ''}${u.subject ?? u.file}`);
  if (items.length > 2) lines.push(`…另 ${items.length - 2} 筆`);
  return lines.join('｜');
}

function tick() {
  heartbeat();
  if (!bellEnabled()) { heartbeat({ mode: 'off' }); return; }
  const live = liveSockets();
  if (live.length > 0) { heartbeat({ mode: 'quiet', sessions: live.length }); return; } // 有對話開著，watcher 會處理
  let r;
  try { r = detect(); } catch (e) { r = { ok: false, error: String(e), errorKind: 'scan' }; }
  if (!r.ok) {
    if (r.errorKind === 'config') { log('還沒設定 config，桌鈴退出'); process.exit(0); }
    heartbeat({ mode: 'scan-fail', error: r.error }); return; // 讀不到交換區：健康帳由 hook 那邊管，桌鈴不吵
  }
  const state = loadState();
  // 餵 arrivals：不追蹤的收件匣檔不算未讀，但剛落地時一樣要響一次（不重響與建基準由 plan 處理）
  const p = plan(r.arrivals ?? r.unread, state, Date.now());
  saveState(p.state);
  heartbeat({ mode: 'armed', unread: r.unreadCount });
  if (p.ring.length === 0) return;
  // 標題數字＝這一刻需要人注意的：追蹤中的未讀，加上這一輪剛落地、不追蹤的
  const title = `交換區信箱：${r.unreadCount + p.freshUntracked} 封未讀${p.fresh ? `（${p.fresh} 封新）` : '（提醒）'}`;
  const ok = notify(title, describe(p.ring));
  log(`響鈴 ok=${ok} 新=${p.fresh} 重複=${p.due} 未讀=${r.unreadCount}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.platform === 'win32') {
    // Windows 沒有 osascript，系統通知另開任務實作。這裡不裝死、不假成功：記一行就走，
    // 讓 ensureDeskbell 下次仍會嘗試帶起（等 Windows 版做好、換掉這段就自動生效）。
    log('Windows 暫無桌鈴實作（系統通知另開任務），退出');
    process.exit(0);
  }
  log(`桌鈴啟動 pid=${process.pid}`);
  tick();
  setInterval(tick, POLL_MS);
}
