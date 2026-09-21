// 已讀記帳的驗收測試（0.6.0）。跑法：
//   node tests/markread.test.mjs
// 全部 assertion 過才 exit 0。測試資料寫在系統暫存目錄，**不碰真實的 ~/.claude**。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..', 'scripts');
const root = join(tmpdir(), 'mailbox-radar-markread-test');
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

const { markRead, ledgerEntries } = await import(pathToFileURL(join(SCRIPTS, 'markread.mjs')).href);
const { formatUnread, shownFiles } = await import(pathToFileURL(join(SCRIPTS, 'format.mjs')).href);
const { detect, readLedger } = await import(pathToFileURL(join(SCRIPTS, 'detect.mjs')).href);

const pass = [];
const fail = [];
const ok = (name, cond, extra = '') => { (cond ? pass : fail).push(name); if (!cond) console.log(`FAIL  ${name}  ${extra}`); };

// ── 1. 基本追加與冪等 ───────────────────────────────────────────
{
  const p = join(root, 'case1', 'read.md');
  let r = markRead(['訊息_甲→乙_主題_2026-09-01.md'], { ledgerPath: p, note: '測試' });
  ok('新帳：建檔並記一筆', r.added.length === 1 && existsSync(p));
  ok('新帳：有標題行', readFileSync(p, 'utf8').startsWith('# team-mailbox 已讀帳'));

  r = markRead(['訊息_甲→乙_主題_2026-09-01.md'], { ledgerPath: p });
  ok('冪等：同一筆再記一次不重複', r.added.length === 0 && r.skipped.length === 1);
  const body = readFileSync(p, 'utf8');
  ok('冪等：檔案裡只出現一次', body.split('訊息_甲→乙_主題_2026-09-01.md').length - 1 === 1);

  r = markRead(['訊息_甲→乙_主題_2026-09-01.md', '公告_新規約_2026-09-02.md'], { ledgerPath: p });
  ok('混合：只記沒記過的那筆', r.added.length === 1 && r.skipped.length === 1);
}

// ── 2. 不破壞使用者既有內容 ─────────────────────────────────────
// 這條擋的是「重寫整個檔」的實作方式：使用者手寫的註記與排版必須原樣保留。
{
  const p = join(root, 'case2', 'read.md');
  mkdirSync(dirname(p), { recursive: true });
  const original = [
    '# team-mailbox 已讀帳（本機）',
    '',
    '回執_安裝包-v1_丙_2026-07-09.md',
    '- 訊息_丁→乙_舊事_2026-07-10.md（2026-07-10 已回，順便問了排程）',
    '',
  ].join('\n');
  writeFileSync(p, original);

  const r = markRead(['公告_新規約_2026-09-02.md'], { ledgerPath: p, note: '開場報過' });
  const after = readFileSync(p, 'utf8');
  ok('追加：原內容逐字保留', after.startsWith(original));
  ok('追加：使用者手寫的註記沒被吃掉', after.includes('已回，順便問了排程'));
  ok('追加：新的一筆在最後', after.trimEnd().endsWith('（2026-09-02 開場報過）') || /公告_新規約_2026-09-02\.md（\d{4}-\d{2}-\d{2} 開場報過）\s*$/.test(after));
  ok('追加：既有兩筆被認出來、沒重記', r.skipped.length === 0 && r.added.length === 1);

  // 既有的兩筆確實被 ledgerEntries 認得
  const have = ledgerEntries(after);
  ok('解析：純檔名行認得', have.has('回執_安裝包-v1_丙_2026-07-09.md'));
  ok('解析：帶條列符號與註記的行認得', have.has('訊息_丁→乙_舊事_2026-07-10.md'));
}

// ── 3. 與 detect 的 readLedger 語意一致 ─────────────────────────
// 兩邊若分岔，會出現「記了但雷達還是算未讀」——最難查的那種。
{
  const p = join(root, 'case3', 'read.md');
  markRead([
    '收件匣-乙/訊息_甲→乙_帶前綴_2026-09-03.md',   // 帶資料夾前綴
    '公告板/公告_也帶前綴_2026-09-04.md',
    '安裝包_某skill_2026-09-05.html',                // html 也算
  ], { ledgerPath: p });
  const mine = ledgerEntries(readFileSync(p, 'utf8'));
  const theirs = readLedger(p);
  ok('一致：markread 與 detect 認到同一組檔名',
    [...mine].sort().join('|') === [...theirs].sort().join('|'),
    `markread=${[...mine].length} detect=${[...theirs].length}`);
  ok('前綴：存進去的是 basename', mine.has('訊息_甲→乙_帶前綴_2026-09-03.md'));
  ok('副檔名：html 也記得住', mine.has('安裝包_某skill_2026-09-05.html'));
}

// ── 4. shownFiles 與 formatUnread 列出的完全一致 ────────────────
// 記帳只記被列出來的，所以這兩個必須是同一個答案。
{
  const unread = [];
  for (let i = 1; i <= 12; i++) {
    unread.push({ file: `訊息_甲→乙_主題${i}_2026-09-${String(i).padStart(2, '0')}.md`, channel: 'inbox', type: '訊息', from: '甲', to: '乙', subject: `主題${i}`, date: `2026-09-${String(i).padStart(2, '0')}` });
  }
  const result = { ok: true, name: '乙', unread, unreadCount: unread.length };
  const text = formatUnread(result, { mode: 'session', limit: 8 });
  const shown = shownFiles(result, { limit: 8 });

  ok('一致：shownFiles 回 8 筆', shown.length === 8);
  ok('一致：每一筆都真的出現在文字裡', shown.every((u) => text.includes(u.file)));
  const notShown = unread.filter((u) => !shown.some((s) => s.file === u.file));
  ok('一致：沒被選中的 4 筆確實沒出現在文字裡', notShown.every((u) => !text.includes(u.file)), `未列出 ${notShown.length} 筆`);
  ok('一致：文字有講還有幾筆沒列', text.includes('另有 4 筆'));
}

// ── 5. 安全性：只記交進來的那些，絕不多記 ───────────────────────
// markRead 是唯一會讓訊息從未讀清單消失的動作，所以它必須嚴格只動被交進來的檔名。
// 呼叫端（skill 處理完一批）通常只交出其中一部分，多記就等於讓沒被處理的訊息
// 靜默消失，而且不會留下任何痕跡。
{
  const p = join(root, 'case5', 'read.md');
  const unread = [];
  for (let i = 1; i <= 12; i++) {
    unread.push({ file: `訊息_甲→乙_主題${i}_2026-09-${String(i).padStart(2, '0')}.md`, channel: 'inbox', type: '訊息', from: '甲', subject: `主題${i}`, date: `2026-09-${String(i).padStart(2, '0')}` });
  }
  const result = { ok: true, name: '乙', unread, unreadCount: unread.length };
  const shown = shownFiles(result, { limit: 8 });
  markRead(shown.map((u) => u.file), { ledgerPath: p, note: '開場報過' });

  const have = ledgerEntries(readFileSync(p, 'utf8'));
  ok('安全：只記了 8 筆', have.size === 8, `實際 ${have.size}`);
  const notShown = unread.filter((u) => !shown.some((s) => s.file === u.file));
  ok('安全：未列出的 4 筆一筆都沒被記', notShown.every((u) => !have.has(u.file)));
}

// ── 6. 端到端：記帳之後 detect 的未讀數真的會降 ─────────────────
{
  const ex = join(root, 'case6', 'fake-交換區');
  const inbox = join(ex, '收件匣-測試員');
  const board = join(ex, '公告板');
  mkdirSync(inbox, { recursive: true });
  mkdirSync(board, { recursive: true });
  const files = ['訊息_甲→測試員_一_2026-09-01.md', '訊息_乙→測試員_二_2026-09-02.md', '回執_一_甲_2026-09-03.md'];
  for (const f of files) writeFileSync(join(inbox, f), 'x');
  writeFileSync(join(board, '公告_某事_2026-09-04.md'), 'x');

  const cfg = join(root, 'case6', 'config.md');
  writeFileSync(cfg, `名字：測試員\n交換區：${ex}\n`);
  const ledger = join(root, 'case6', 'read.md');

  const before = detect({ configPath: cfg, ledgerPath: ledger });
  ok('端到端：一開始 4 筆未讀', before.unreadCount === 4, `實際 ${before.unreadCount}`);

  const shown = shownFiles(before, { limit: 2 });
  markRead(shown.map((u) => u.file), { ledgerPath: ledger, note: '開場報過' });

  const after = detect({ configPath: cfg, ledgerPath: ledger });
  ok('端到端：記了 2 筆之後剩 2 筆', after.unreadCount === 2, `實際 ${after.unreadCount}`);
  ok('端到端：剩下的正是沒被記的那兩筆',
    after.unread.every((u) => !shown.some((s) => s.file === u.file)));

  // 再跑一次開場：把剩下的也記掉，未讀歸零
  const shown2 = shownFiles(after, { limit: 8 });
  markRead(shown2.map((u) => u.file), { ledgerPath: ledger, note: '開場報過' });
  const final = detect({ configPath: cfg, ledgerPath: ledger });
  ok('端到端：第二輪之後未讀歸零', final.unreadCount === 0, `實際 ${final.unreadCount}`);

  // 新訊息落地仍然報得出來（記帳不會把未來的也蓋掉）
  writeFileSync(join(inbox, '訊息_丙→測試員_新的_2026-09-10.md'), 'x');
  const fresh = detect({ configPath: cfg, ledgerPath: ledger });
  ok('端到端：新訊息照樣算未讀', fresh.unreadCount === 1 && fresh.unread[0].file === '訊息_丙→測試員_新的_2026-09-10.md');
}

// ── 7. 邊界 ─────────────────────────────────────────────────────
{
  const p = join(root, 'case7', 'read.md');
  ok('邊界：空陣列不建檔', markRead([], { ledgerPath: p }).added.length === 0 && !existsSync(p));
  ok('邊界：空字串與 null 被略過', markRead(['', null, undefined], { ledgerPath: p }).added.length === 0);

  // 沒有結尾換行的既有檔，追加不能黏在最後一行後面
  const p2 = join(root, 'case7b', 'read.md');
  mkdirSync(dirname(p2), { recursive: true });
  writeFileSync(p2, '# 帳\n\n訊息_甲→乙_無換行結尾_2026-09-01.md');
  markRead(['公告_新的_2026-09-02.md'], { ledgerPath: p2 });
  const lines = readFileSync(p2, 'utf8').split('\n');
  ok('邊界：沒有結尾換行時不會黏行',
    lines.some((l) => l.trim() === '訊息_甲→乙_無換行結尾_2026-09-01.md'),
    JSON.stringify(lines));
  ok('邊界：黏行檢查後兩筆都認得', ledgerEntries(readFileSync(p2, 'utf8')).size === 2);
}

// ── 8. CLI：不帶 --note 也不能丟掉檔名（回歸）─────────────────
// 曾經 `i !== ni + 1` 在沒有 --note 時 ni = -1，把第 0 個參數當成 note 的值濾掉：
// 單檔印用法 exit 2，多檔靜默漏記第一個。前面 29 條全在函式層，蓋不到命令列這條路。
{
  const { spawnSync } = await import('node:child_process');
  const p = join(root, 'case8', 'read.md');
  const env = { ...process.env, MAILBOX_RADAR_LEDGER: p };
  const cli = (...a) => spawnSync(process.execPath, [join(SCRIPTS, 'markread.mjs'), ...a], { env, encoding: 'utf8' });
  const added = (r) => { try { return JSON.parse(r.stdout).added.length; } catch { return -1; } };

  let r = cli('訊息_甲→乙_一_2026-09-01.md', '訊息_甲→乙_二_2026-09-02.md');
  ok('CLI：不帶 --note、兩個檔名 → exit 0', r.status === 0, r.stderr);
  ok('CLI：不帶 --note、兩個檔名 → 兩筆都記到', added(r) === 2, r.stdout);

  r = cli('訊息_甲→乙_三_2026-09-03.md');
  ok('CLI：不帶 --note、單一檔名 → 記得到、不印用法', r.status === 0 && added(r) === 1, r.stdout + r.stderr);

  r = cli('--note', '已回覆', '訊息_甲→乙_四_2026-09-04.md');
  ok('CLI：--note 放前面照常', r.status === 0 && added(r) === 1, r.stdout + r.stderr);

  r = cli('訊息_甲→乙_五_2026-09-05.md', '--note', '放在後面');
  ok('CLI：--note 放在檔名後面也行', r.status === 0 && added(r) === 1, r.stdout + r.stderr);

  const body = readFileSync(p, 'utf8');
  ok('CLI：--note 的值沒被當成檔名記進去', !body.includes('- 已回覆（') && !body.includes('- 放在後面（'));
  ok('CLI：註記有寫進去', body.includes('已回覆）') && body.includes('放在後面）'));
  ok('CLI：預設註記不再是「開場報過」', !body.includes('開場報過') && body.includes('已處理）'));
  ok('CLI：五筆全在帳上', ledgerEntries(body).size === 5, [...ledgerEntries(body)].join('、'));

  r = cli();
  ok('CLI：什麼都沒給 → 印用法 exit 2', r.status === 2);
}

// ── 更新既有註記（--update）──────────────────────────────────
{
  const p = join(root, 'update-ledger.md');
  markRead(['a.md', 'b.md'], { ledgerPath: p, note: '待本人決定，附件_x.md 先不動' });
  let r = markRead(['a.md'], { ledgerPath: p, note: '已回覆' });
  ok('update：沒帶 update 時同檔名照舊跳過', r.skipped.includes('a.md') && r.updated === undefined);
  ok('update：沒帶 update 時註記沒變', /a\.md（\S+ 待本人決定/.test(readFileSync(p, 'utf8')));
  r = markRead(['a.md', 'c.md'], { ledgerPath: p, note: '已回覆', update: true });
  const text = readFileSync(p, 'utf8');
  ok('update：回報 updated 與 added 分開', r.updated?.join() === 'a.md' && r.added.join() === 'c.md');
  ok('update：既有那一行的註記換掉了', /- a\.md（\S+ 已回覆）/.test(text) && !/a\.md（\S+ 待本人決定/.test(text), text);
  ok('update：別的行不受影響', /- b\.md（\S+ 待本人決定，附件_x\.md 先不動）/.test(text), text);
  ok('update：同一個檔名不會出現兩行', text.split('\n').filter((l) => /^- a\.md/.test(l)).length === 1);
  r = markRead(['附件_x.md'], { ledgerPath: p, note: '另記', update: true });
  ok('update：註記正文裡提到的檔名不算在帳上，會新增而不是改別人的行', r.added.join() === '附件_x.md' && /- b\.md（\S+ 待本人決定，附件_x\.md 先不動）/.test(readFileSync(p, 'utf8')));
}

// ── 結果 ─────────────────────────────────────────────────────────
for (const name of pass) console.log(`  ok  ${name}`);
console.log(`\n${pass.length} passed, ${fail.length} failed`);
rmSync(root, { recursive: true, force: true });
process.exit(fail.length ? 1 : 0);
