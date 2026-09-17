#!/usr/bin/env node
// mailbox-radar · 單機認領鎖
//
// 解什麼：同一封訊息落地會喚醒這臺機器上**每一個**開著的對話，兩個對話可能搶在任何一方
// 記帳之前都動手（重複回執、重複問人）。已讀帳是「處理完才寫」，攔得住事後重複記錄、
// 攔不住事中重複行動。所以在動手之前先搶一張票。
//
// 機制：以 O_EXCL（flag 'wx'）原子建檔 claims/<訊息檔名>.claim——作業系統保證同一路徑
// 兩個行程只有一個建成功，不依賴誰快誰慢。票上寫認領者的 session 通道路徑與時刻。
//
// 接管判準：
//   主：認領者的 session 通道已消失（對話被關／當機）→ 立刻可接管
//   後備：session 還活著但認領 ≥ 15 分鐘沒記帳（卡住不動的殭屍）→ 可接管
//   同一個 session 重跑 → 視為自己的票（idempotent）
//
// 用法： node claim.mjs <訊息檔絕對路徑或檔名>
// 輸出（單行 JSON）：{ won, reason, holder:{sock,at,ageSec}|null, claimFile }
//   won=true  → 動手（順位：claim → gate → classify → 動手 → 已讀帳）
//   won=false → 對使用者說一句「這封已由另一個對話在處理」，然後停手，不跑分類器
//
// 釋放：不需要。已讀帳的記錄就是「處理完」的訊號；票留著無害，24 小時以上的舊票順手清掉。
//
// 跨機不互斥：claims/ 在本機。兩臺機器同時開著對話時，各自的 claim 鎖互不知情——
// 那是收件對話設計（主備值班）要處理的事，不在這支的範圍。
//
// 身分＝CLAUDE_CODE_MESSAGING_SOCKET。Bash 工具的子行程拿得到這個環境變數（實測），
// macOS 上是 socket 檔路徑、Windows 上是 named pipe 路徑，socketAlive() 兩種都能判。

import { basename, join } from 'node:path';
import { mkdirSync, openSync, closeSync, writeSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolveDataDir, socketAlive } from './paths.mjs';
import { exchangeForPath } from './detect.mjs';

export const TAKEOVER_MS = 15 * 60 * 1000;
const SWEEP_MS = 24 * 60 * 60 * 1000;

function claimsDir(dataDir) { return join(dataDir, 'claims'); }

function sweep(dir) {
  try {
    const now = Date.now();
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.claim')) continue;
      try { if (now - statSync(join(dir, f)).mtimeMs > SWEEP_MS) unlinkSync(join(dir, f)); } catch {}
    }
  } catch {}
}

/**
 * 認領一封訊息。
 * @param {string} messageFile 訊息檔路徑或檔名
 * @param {{dataDir?:string, sock?:string|null, now?:number}} [opts]
 */
export function claim(messageFile, opts = {}) {
  const dataDir = opts.dataDir ?? resolveDataDir();
  const me = opts.sock === undefined ? (process.env.CLAUDE_CODE_MESSAGING_SOCKET ?? null) : opts.sock;
  const now = opts.now ?? Date.now();
  const dir = claimsDir(dataDir);
  mkdirSync(dir, { recursive: true });
  sweep(dir);
  // 票名要跨交換區唯一：兩個交換區可能有同名檔，用純檔名會讓兩封不相干的訊息搶同一張票。
  // 預設交換區（以及判斷不出屬於哪一區的，例如只給了檔名）維持純檔名，舊票照樣有效。
  const exchangeId = opts.exchangeId !== undefined ? opts.exchangeId : (exchangeForPath(messageFile)?.id ?? null);
  const prefix = exchangeId ? `${String(exchangeId).replace(/[\\/:*?"<>|]/g, '_')}__` : '';
  const file = join(dir, `${prefix}${basename(messageFile)}.claim`);
  const ticket = JSON.stringify({ sock: me, at: new Date(now).toISOString() });

  // 1. 原子搶票
  try {
    const fd = openSync(file, 'wx');
    writeSync(fd, ticket);
    closeSync(fd);
    return { won: true, reason: 'claimed', holder: null, claimFile: file };
  } catch (err) {
    if (err?.code !== 'EEXIST') return { won: false, reason: `claim 失敗（${err?.message ?? err}），保守不動手`, holder: null, claimFile: file };
  }

  // 2. 已有票：讀出來看是誰、活不活
  let holder;
  try { holder = JSON.parse(readFileSync(file, 'utf8')); }
  catch { holder = { sock: null, at: null }; }
  const ageMs = holder.at ? now - Date.parse(holder.at) : Infinity;
  const view = { sock: holder.sock ?? null, at: holder.at ?? null, ageSec: Number.isFinite(ageMs) ? Math.round(ageMs / 1000) : null };

  if (me && holder.sock === me) {
    return { won: true, reason: 'own', holder: view, claimFile: file }; // 自己的票，重跑無害
  }
  const alive = socketAlive(holder.sock); // true／false／null（不知道）
  if (alive === false) {
    writeFileSync(file, ticket);
    return { won: true, reason: 'takeover:holder-dead', holder: view, claimFile: file };
  }
  if (ageMs >= TAKEOVER_MS) {
    writeFileSync(file, ticket);
    return { won: true, reason: 'takeover:timeout', holder: view, claimFile: file };
  }
  return { won: false, reason: 'held', holder: view, claimFile: file };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!target) {
    process.stderr.write('用法：node claim.mjs <訊息檔絕對路徑或檔名>\n');
    process.exit(2);
  }
  process.stdout.write(JSON.stringify(claim(target)) + '\n');
}
