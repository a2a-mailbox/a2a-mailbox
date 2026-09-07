import { mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
// 偵測器的驗收測試（Phase 1 task 2）。跑法：
//   node tests/detect.test.mjs
// 全部 assertion 過才 exit 0。測試資料寫在系統暫存目錄，不碰真實交換區。
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const { detect } = await import(join(HERE, '..', 'scripts', 'detect.mjs'));

const root = join(tmpdir(), 'mailbox-radar-test');
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const ex = join(root, 'fake-交換區');
rmSync(ex, { recursive: true, force: true });
const inbox = join(ex, '收件匣-測試員');
const board = join(ex, '公告板');
mkdirSync(inbox, { recursive: true });
mkdirSync(board, { recursive: true });

const inboxFiles = [
  '訊息_小明→測試員_甲主題_2026-08-01.md',
  '訊息_小華→測試員_乙主題_多段slug_2026-08-02.md',
  '回執_甲主題_小美_2026-08-03.md',
  '附件_某附件_2026-08-04.md',
  '.DS_Store',
  '筆記.txt',
];
const boardFiles = [
  '安裝包_某skill-v2_2026-08-05.html',
  '公告_規約更新_2026-08-06.md',
  '舊指南_2026-07-01.html',
];
for (const f of inboxFiles) writeFileSync(join(inbox, f), 'x');
for (const f of boardFiles) writeFileSync(join(board, f), 'x');

const cfg = join(root, 'fake-config.md');
writeFileSync(cfg, `名字：測試員\n交換區：${ex}\n`);
const ledger = join(root, 'fake-read.md');
writeFileSync(ledger, [
  '# 已讀帳',
  '',
  '- 訊息_小明→測試員_甲主題_2026-08-01.md（2026-08-01 已讀；註記裡提到 公告_規約更新_2026-08-06.md 但那筆沒讀過）',
  '- 安裝包_某skill-v2_2026-08-05.html（已裝）',
  '',
].join('\n'));

const opts = { configPath: cfg, ledgerPath: ledger };
const fail = [];
const ok = (cond, label, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`); if (!cond) fail.push(label); };

// 斷言 1：差集大小 = (掃到的 .md/.html 數) - (已讀帳命中數)
const r1 = detect(opts);
const scannedTotal = r1.scanned.inbox.total + r1.scanned.board.total;
ok(r1.ok, '偵測器跑得起來', r1.error ?? '');
ok(scannedTotal === 7, `掃到 7 個計數檔（排除 .DS_Store 與 .txt）`, `實際 ${scannedTotal}`);
ok(r1.ledgerCount === 2, '已讀帳認 2 筆（註記裡提到的第三個檔名不算）', `實際 ${r1.ledgerCount}`);
ok(r1.unreadCount === 5, '未讀 = 7 - 2 = 5', `實際 ${r1.unreadCount}`);
ok(r1.unread.length === r1.unreadCount, 'unreadCount 與清單長度一致');
ok(r1.unread.some(u => u.file === '公告_規約更新_2026-08-06.md'), '註記裡被提到的檔仍算未讀（不被靜默隱藏）');

// 斷言 2：同一批檔再掃一次，結果逐字相同、沒有重複
const r2 = detect(opts);
const key = (r) => r.unread.map(u => u.file).join('|');
ok(key(r1) === key(r2), '再掃一次結果逐字相同');
ok(new Set(r2.unread.map(u => u.file)).size === r2.unread.length, '清單內沒有重複檔名');

// 斷言 3：檔名 metadata 解析正確
const m = Object.fromEntries(r2.unread.map(u => [u.file, u]));
const a = m['訊息_小華→測試員_乙主題_多段slug_2026-08-02.md'];
ok(a && a.type === '訊息' && a.from === '小華' && a.to === '測試員' && a.subject === '乙主題・多段slug' && a.date === '2026-08-02', '訊息：寄件人／收件人／多段主題／日期都對', JSON.stringify(a));
const b = m['回執_甲主題_小美_2026-08-03.md'];
ok(b && b.type === '回執' && b.from === '小美' && b.subject === '甲主題', '回執：回覆人在日期前一格', JSON.stringify(b));
const c = m['舊指南_2026-07-01.html'];
ok(c && c.type === '其他' && c.subject === '舊指南', '不合 schema 的檔名不會爆掉，歸「其他」', JSON.stringify(c));

// 斷言 4：新檔落地後偵測得到（且沒用資料夾 mtime——來源碼另外 grep 驗）
writeFileSync(join(inbox, '訊息_小強→測試員_新來的_2026-08-26.md'), 'x');
const r3 = detect(opts);
ok(r3.unreadCount === 6, '新檔落地後未讀 5 → 6', `實際 ${r3.unreadCount}`);
ok(r3.unread[0].file === '訊息_小強→測試員_新來的_2026-08-26.md', '排序：最新的排最前面');

// 斷言 5：不讀檔案內容——把所有檔設成不可讀，偵測器照樣完整回報。
// Windows 上 chmod 幾乎無效（斷言會假陽性通過），明確跳過而不是假裝測了。
if (process.platform !== 'win32') {
  for (const f of ['訊息_小強→測試員_新來的_2026-08-26.md', '附件_某附件_2026-08-04.md']) chmodSync(join(inbox, f), 0o000);
  const r4 = detect(opts);
  ok(r4.ok && r4.unreadCount === 6, '檔案 chmod 000 仍能回報 6 筆（證明沒開檔讀內容）', r4.error ?? '');
  for (const f of ['訊息_小強→測試員_新來的_2026-08-26.md', '附件_某附件_2026-08-04.md']) chmodSync(join(inbox, f), 0o644);
} else {
  console.log('SKIP  chmod 斷言（Windows 上 chmod 無效，避免假陽性）');
}

// 斷言 6：資料夾不存在不當錯誤（同事機器上收件匣還沒建）
const cfg2 = join(root, 'fake-config-2.md');
writeFileSync(cfg2, `名字：不存在的人\n交換區：${ex}\n`);
const r5 = detect({ configPath: cfg2, ledgerPath: ledger });
ok(r5.ok && r5.scanned.inbox.missing === true, '收件匣不存在 → missing:true，不丟錯');

// 斷言 6.5：自產的已讀彙總檔不進未讀清單
writeFileSync(join(inbox, '已讀-測試員.md'), 'x');
const r5b = detect({ configPath: cfg, ledgerPath: ledger });
ok(!r5b.unread.some(u => u.file.startsWith('已讀-')), '已讀-*.md 彙總檔被排除在未讀之外');

// 斷言 7：沒有已讀帳（新同事）視為空帳
const r6 = detect({ configPath: cfg, ledgerPath: join(root, '不存在的read.md') });
ok(r6.ok && r6.unreadCount === 8, '沒有 read.md → 全部 8 個都算未讀', `實際 ${r6.unreadCount}`);

// 斷言 8：帶資料夾前綴的已讀帳條目也認得（0.4.3，試點使用者回報 bug 2——
// team-mailbox skill 寫入格式是「公告板/檔名」「收件匣-X/檔名」，前綴版比不到
// 會讓升級機的歷史已讀全部詐屍成未讀）
const ledgerPrefixed = join(root, 'fake-read-prefixed.md');
writeFileSync(ledgerPrefixed, [
  '- 公告板/安裝包_某skill-v2_2026-08-05.html（已裝）',
  '- 收件匣-測試員/訊息_小明→測試員_甲主題_2026-08-01.md（已回）',
  '- 訊息_小華→測試員_乙主題_多段slug_2026-08-02.md（純檔名混用也要通）',
  '',
].join('\n'));
const r7 = detect({ configPath: cfg, ledgerPath: ledgerPrefixed });
ok(r7.ledgerCount === 3, '前綴版＋純檔名混用的已讀帳認滿 3 筆', `實際 ${r7.ledgerCount}`);
ok(!r7.unread.some(u => u.file === '安裝包_某skill-v2_2026-08-05.html'), '公告板/ 前綴條目正確視為已讀');
ok(!r7.unread.some(u => u.file === '訊息_小明→測試員_甲主題_2026-08-01.md'), '收件匣-X/ 前綴條目正確視為已讀');

console.log(`\n${fail.length === 0 ? 'ALL PASS' : 'FAILED: ' + fail.join(', ')}`);
console.log('掃真實交換區耗時（毫秒）:', detect().elapsedMs.toFixed(2));
process.exit(fail.length ? 1 : 0);
