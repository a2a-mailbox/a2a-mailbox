#!/usr/bin/env node
// mailbox-radar · 已讀記帳（0.6.0）
//
// 為什麼要有這一支：
//   0.5.x 把「處理完把檔名追加進 read.md」寫成 team-mailbox skill 裡的一句散文指示，
//   靠當下那個 Claude 記得做、而且寫對路徑。實測結果是它幾乎不會發生——2026-09-10
//   在一臺運作中的機器上查到已讀帳停在 07-21，之後兩個月進來的 45 封訊息一筆都沒記，
//   雷達因此在每個對話都虛報 58 封未讀，真實數字是 6 封。
//
//   記帳這種「每次都要做、做錯了當下沒人發現」的事，要嘛交給程式，要嘛就是不會發生。
//   所以這支存在的意義是把那句散文指示換成一個可呼叫、冪等、會回報結果的動作。
//
// 兩個呼叫端，都在「人真的處理過之後」：
//   1. 開場注入附帶的記帳指示：使用者在那個對話裡確實處理了某幾封，Claude 照指示呼叫。
//      雷達本身不會自動記帳。把訊息列出來只證明機器掃到了，不證明人看了；
//      未讀數的意思是「人還沒處理」，不是「機器還沒報過」。
//   2. team-mailbox skill 的「查信箱」與 mailbox-triage 的收尾：處理完一批訊息後帶著檔名呼叫。
//
// 用法：
//   node markread.mjs [--note "<註記>"] <檔名> [<檔名>...]
//   node markread.mjs [--note "<註記>"] --stdin      （一行一個檔名）
//   node markread.mjs --list                          （印出目前記了哪些）
//
// 冪等：已經在帳上的檔名不會重複追加，回報裡列在 skipped。

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ledgerPath as defaultLedgerPath } from './userdata.mjs';

const HEADER = '# team-mailbox 已讀帳（本機）\n';

/** 已讀帳位置。環境變數覆寫只給測試與除錯用。 */
export function resolveLedgerPath(p) {
  return p || process.env.MAILBOX_RADAR_LEDGER || defaultLedgerPath();
}

/**
 * 讀出帳上已有的檔名集合。
 * 比對規則刻意與 detect.mjs 的 readLedger 一致：只認每行開頭那一個檔名，
 * 並取 basename（帳上可能寫成「公告板/檔名」）。兩邊若不一致，會出現
 * 「記了但雷達還是算未讀」這種最難查的狀況。
 */
export function ledgerEntries(raw) {
  const seen = new Set();
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const body = line.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, '').trim();
    const token = body.split(/[（(\s]/)[0];
    const name = token.split(/[\\/]/).pop();
    if (/\.(?:md|html)$/i.test(name)) seen.add(name);
  }
  return seen;
}

/** 本地日期（到日），註記用。 */
function today(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * 把檔名記進已讀帳。**追加，不重寫**——使用者手寫的註記與排版要原樣保留。
 * @param {string[]} files 檔名（不要帶資料夾前綴也可以帶，會取 basename）
 * @param {{ledgerPath?:string, note?:string, now?:Date}} opts
 * @returns {{added:string[], skipped:string[], path:string}}
 */
export function markRead(files, opts = {}) {
  const path = resolveLedgerPath(opts.ledgerPath);
  // 預設註記是「已處理」。曾經是「開場報過」，那是一度採用、後來被推翻的「報過就算已讀」語意；
  // 留著會讓人讀已讀帳時誤以為這筆只是被雷達列出來過，而不是人真的處理了。
  const note = opts.note ?? '已處理';
  const stamp = today(opts.now);

  let raw = '';
  try { raw = readFileSync(path, 'utf8'); } catch { /* 還沒有帳＝空帳，下面會建 */ }
  const have = ledgerEntries(raw);

  const added = [];
  const skipped = [];
  for (const f of files) {
    const name = String(f ?? '').split(/[\\/]/).pop().trim();
    if (!name) continue;
    if (have.has(name)) { skipped.push(name); continue; }
    have.add(name);
    added.push(name);
  }
  if (added.length === 0) return { added, skipped, path };

  mkdirSync(dirname(path), { recursive: true });
  if (!raw) {
    writeFileSync(path, HEADER + '\n');
    raw = HEADER + '\n';
  }
  // 追加前確保上一行有換行，否則會黏在使用者最後一行的尾巴上
  const lead = raw.endsWith('\n') ? '' : '\n';
  const lines = added.map((n) => `- ${n}（${stamp} ${note}）`).join('\n');
  appendFileSync(path, lead + lines + '\n');
  return { added, skipped, path };
}

// ── CLI ────────────────────────────────────────────────────────

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(''));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const ni = args.indexOf('--note');
  const note = ni >= 0 ? args[ni + 1] : undefined;
  // 沒有 --note 時 ni 是 -1。不先擋掉的話，`i !== ni + 1` 會變成 `i !== 0`，
  // 把第一個檔名當成 note 的值濾掉：單檔會印用法退出，多檔會靜默漏記第一個——
  // 症狀跟這支要修的「記帳不可靠」一模一樣。
  const rest = args.filter((a, i) => !a.startsWith('--') && (ni < 0 || i !== ni + 1));

  const run = (files) => {
    if (files.length === 0) {
      console.error('用法: markread.mjs [--note "<註記>"] <檔名>... ｜ --stdin ｜ --list');
      process.exit(2);
    }
    const r = markRead(files, { note });
    process.stdout.write(JSON.stringify(r) + '\n');
    process.exit(0);
  };

  if (args.includes('--list')) {
    const path = resolveLedgerPath();
    let raw = '';
    try { raw = readFileSync(path, 'utf8'); } catch {}
    process.stdout.write(JSON.stringify({ path, entries: [...ledgerEntries(raw)] }) + '\n');
    process.exit(0);
  } else if (args.includes('--stdin')) {
    readStdin().then((s) => run(s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)));
  } else {
    run(rest);
  }
}
