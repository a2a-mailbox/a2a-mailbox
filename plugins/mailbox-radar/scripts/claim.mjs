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
// 用法： node claim.mjs <訊息檔絕對路徑或檔名> [--exchange <交換區名稱>]
//   給絕對路徑最穩：會自己判斷那封屬於哪個交換區。只給檔名時判斷不出來，
//   額外交換區的訊息要多帶 --exchange，否則兩個交換區的同名檔會搶同一張票。
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
import { listExchanges } from './userdata.mjs';

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

/**
 * 解析命令列。認得的旗標會吃掉自己的值；不認得的旗標直接報錯。
 * 0.7.1 以前是「取第一個不是 -- 開頭的參數」，`--exchange 雙機 <檔名>` 會把「雙機」當成訊息檔，
 * 建出一張沒有意義的票還回報 won:true，看起來像成功。認領是「動手之前的保險」，
 * 保險悄悄失效比沒有保險更糟，所以參數有任何看不懂的地方都不猜、直接退出。
 * @returns {{target:string|null, exchangeId:string|undefined, error:string|null}}
 */
export function parseClaimArgs(argv) {
  const VALUE_FLAGS = new Set(['--exchange', '--data']); // --data 由 paths.mjs 的 resolveDataDir 讀，這裡只負責跳過它的值
  const out = { target: null, exchangeId: undefined, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) return { ...out, error: `${a} 後面要接一個值` };
      if (a === '--exchange') out.exchangeId = v;
      i++;
    } else if (a.startsWith('--')) {
      return { ...out, error: `不認得的旗標 ${a}` };
    } else if (out.target === null) {
      out.target = a;
    } else {
      return { ...out, error: `一次只認領一封，多出來的參數：${a}` };
    }
  }
  if (!out.target) out.error = '沒有給訊息檔';
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseClaimArgs(process.argv.slice(2));
  const die = (msg) => {
    process.stderr.write(`${msg}\n用法：node claim.mjs <訊息檔絕對路徑或檔名> [--exchange <交換區名稱>]\n`);
    process.exit(2);
  };
  if (args.error) die(args.error);
  const opts = {};
  if (args.exchangeId !== undefined) {
    const known = listExchanges().map((x) => x.id).filter(Boolean);
    if (!known.includes(args.exchangeId)) die(`沒有叫「${args.exchangeId}」的交換區（這臺掛著的額外交換區：${known.join('、') || '無'}）`);
    const fromPath = exchangeForPath(args.target)?.id ?? null;
    if (fromPath && fromPath !== args.exchangeId) die(`路徑屬於交換區「${fromPath}」，跟 --exchange ${args.exchangeId} 對不起來`);
    opts.exchangeId = args.exchangeId;
  }
  process.stdout.write(JSON.stringify(claim(args.target, opts)) + '\n');
}
