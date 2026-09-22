// mailbox-radar · autoread（0.8.0）：寫出回執的同時，把被回覆的那封原訊息記進已讀帳
//
// 為什麼：已讀帳是整臺機器共用的，只要處理的那個對話有記帳，其他對話就不會再報未讀。
// 實際發生的失敗是「回了信、沒記帳」——回信與記帳是兩個動作，模型常做完前者忘了後者，
// 於是那封信在這臺機器上每個對話都一直算未讀。把記帳綁在「回執寫出」這個事件上，
// 回信就等於記帳，不再靠人記得。
//
// 判定：hook 看到工具寫出一個檔，檔名是 回執_<slug>_<回覆人>_<日期>.md、位於某個掛著的交換區的
// 收件匣-<甲>/ 底下，就到**自己**收件匣找 from 是甲、主題 slug 相同的 訊息／請求，記進該交換區的帳。
// 找不到就什麼都不做（可能是回別人轉述的事、或原信在公告板），不猜。
// 只處理「讀了之後回信」這一種；「讀了決定不處理」仍要人（或模型）自己跑 markread。

import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { exchangeForPath, parseFilename, readConfig } from './detect.mjs';
import { markRead } from './markread.mjs';

/** 從工具呼叫的輸入裡撈出可能剛寫出的回執路徑。Write／Edit 看 file_path；Bash 看指令字串裡有沒有回執檔路徑。 */
export function replyPathsFromTool(toolName, toolInput = {}) {
  if (!toolInput || typeof toolInput !== 'object') return [];
  if (toolName === 'Write' || toolName === 'Edit') {
    const p = toolInput.file_path;
    return typeof p === 'string' && /回執_[^\\/]+\.md$/i.test(p) ? [p] : [];
  }
  if (toolName === 'Bash') {
    const cmd = String(toolInput.command ?? '');
    const out = new Set();
    for (const m of cmd.matchAll(/[^\s"'<>|;&]*收件匣-[^\s"'<>|;&]*?回執_[^\s"'<>|;&]+\.md/g)) out.add(m[0]);
    return [...out];
  }
  return [];
}

/**
 * 寫出了一個回執：找出它回覆的原訊息並記帳。
 * @param {string} replyPath 剛寫出的回執檔路徑
 * @param {{exchanges?:Array, now?:Date}} [opts] exchanges 測試用：[{id, ledgerPath, exchangePath, name}]
 * @returns {{marked:string[], exchangeId:string|null, reason?:string}}
 */
export function autoReadOnReply(replyPath, opts = {}) {
  const none = (reason) => ({ marked: [], exchangeId: null, reason });
  const reply = parseFilename(basename(replyPath));
  if (reply.type !== '回執' || !reply.subject) return none('不是回執');

  // 回執放在誰的收件匣，誰就是原訊息的寄件人
  const m = String(replyPath).replace(/\\/g, '/').match(/\/收件匣-([^/]+)\/[^/]+$/);
  if (!m) return none('不在收件匣裡');
  const sender = m[1];

  const ex = exchangeForPath(replyPath, opts.exchanges);
  if (!ex) return none('不在任何掛著的交換區裡');
  let name = ex.name;
  if (!name) { try { name = readConfig(ex.configPath).name; } catch { return none('讀不到交換區設定'); } }
  if (!name) return none('交換區設定沒有名字');
  if (name === sender) return none('回執寫在自己的收件匣'); // 自己回自己：不是這裡要處理的

  const myInbox = join(ex.exchangePath, `收件匣-${name}`);
  let files = [];
  try { files = readdirSync(myInbox); } catch { return none('自己的收件匣讀不到'); }
  const targets = files.filter((f) => {
    if (!/\.md$/i.test(f)) return false;
    const p = parseFilename(f);
    return (p.type === '訊息' || p.type === '請求') && p.from === sender && p.subject === reply.subject;
  });
  if (targets.length === 0) return none('自己的收件匣裡沒有同主題、同寄件人的原訊息');

  const r = markRead(targets, { ledgerPath: ex.ledgerPath, note: `已回執（${basename(replyPath)}）`, now: opts.now });
  return { marked: r.added, alreadyMarked: r.skipped, exchangeId: ex.id ?? null };
}
