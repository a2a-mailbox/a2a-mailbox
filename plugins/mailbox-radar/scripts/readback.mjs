#!/usr/bin/env node
// team-mailbox-radar · 已讀回寫（Phase 3 task 11）
//
// 把本機 read.md（工作副本）鏡射成交換區的彙總檔 `收件匣-<自己>/已讀-<自己>.md`，
// 讓寄件人的 agent 掃自己寄過去的訊息有沒有被讀到。
//
// 記兩個狀態、不是一個：
//   已掃到＝對方的 agent 讀進去了（機器事實；來源＝read.md 出現該檔名）
//   已告知人＝對方的人真的被通知了（投遞階梯第三階才有；目前一律空白）
// 只記一個「已讀」會被誤讀成「對方知道了」——那比沒有標記更危險。
//
// 寫入條件：read.md 內容雜湊變了才寫（Drive 寫入不便宜，也避免 mtime 噪音）。
// 單一 writer：彙總檔只有本人會寫，放自己的收件匣，符合交換區規約。

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readConfig, readLedger } from './detect.mjs';
import { resolveDataDir } from './paths.mjs';
import { ledgerPath as defaultLedgerPath } from './userdata.mjs';

const STATE = 'readback-state.json';

export function syncReadback(opts = {}) {
  const dataDir = opts.dataDir ?? resolveDataDir();
  const { name, exchange, inboxTracking } = readConfig(opts.configPath);
  // 收件匣交給其他系統追蹤時不鏡射：這臺的 read.md 不記收件匣處理過沒有，寫出去的彙總檔
  // 會讓寄件人以為「沒掃到」。而且同一個人另一臺機器若在同一區用同一個代稱，兩臺會輪流
  // 覆寫同一份 `已讀-<代稱>.md`，Drive 還可能分叉出「(1)」。讓雷達自己追的那臺當唯一 writer。
  if (inboxTracking === 'external') return { wrote: false, why: '收件匣交給其他系統追蹤，彙總檔不由這臺寫' };
  const ledgerPath = opts.ledgerPath ?? defaultLedgerPath();

  let raw = '';
  try { raw = readFileSync(ledgerPath, 'utf8'); } catch { /* 沒有帳＝沒東西可鏡射 */ }
  const hash = createHash('sha256').update(raw).digest('hex');

  let state = { hash: null, scannedAt: {} };
  // 每個交換區各一份狀態：各自的帳、各自的「上次鏡射時的雜湊」。預設交換區沿用原本的檔名。
  const stateName = opts.exchangeId
    ? `readback-state-${String(opts.exchangeId).replace(/[\\/:*?"<>|]/g, '_')}.json`
    : STATE;
  const statePath = join(dataDir, stateName);
  try { state = { ...state, ...JSON.parse(readFileSync(statePath, 'utf8')) }; } catch {}

  if (state.hash === hash) return { wrote: false, why: 'read.md 未變' };

  // 已掃到時刻＝檔名第一次出現在 read.md 的時刻（之後不再變動）
  const files = [...readLedger(ledgerPath)];
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  for (const f of files) if (!state.scannedAt[f]) state.scannedAt[f] = now;

  const lines = [
    `# 已讀狀態彙總 — ${name}`,
    '',
    '> 本檔由信箱雷達自動維護（單一 writer＝本人的機器），供寄件人的 agent 查閱。',
    '> 「已掃到」＝我的 agent 讀進去了（機器事實）；「已告知人」＝我本人真的被通知了。',
    '> 兩者不同：只看到「已掃到」不代表本人知道了。',
    '',
    '| 訊息檔 | 已掃到（UTC） | 已告知人 |',
    '|---|---|---|',
    ...files.sort().map((f) => `| ${f} | ${state.scannedAt[f]} | |`),
    '',
  ];

  const out = join(exchange, `收件匣-${name}`, `已讀-${name}.md`);
  writeFileSync(out, lines.join('\n'));
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(statePath, JSON.stringify({ hash, scannedAt: state.scannedAt }));
  return { wrote: true, out, entries: files.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(JSON.stringify(syncReadback()) + '\n');
  process.exit(0);
}
