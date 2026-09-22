// 「寫出回執就把原訊息記進已讀帳」的驗收測試。跑法：node tests/autoread.test.mjs
// 測試資料寫在系統暫存目錄，不碰真實 data dir 與真實交換區。
// 交換區根目錄刻意帶空白與 &（真實路徑就是這樣），Bash 撈路徑那一段曾在這裡斷掉。
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const { autoReadOnReply, replyPathsFromTool, rootVariants } = await import(pathToFileURL(join(HERE, '..', 'scripts', 'autoread.mjs')).href);
const root = join(tmpdir(), 'mailbox-radar-autoread-test');
rmSync(root, { recursive: true, force: true });
const WIN = process.platform === 'win32';

let n = 0, fail = 0;
function eq(name, got, want) { n++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) { fail++; console.log(`✗ ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); } else console.log(`✓ ${name}`); }

// 假交換區：我是「乙」，甲寄信給我，我回執到甲的收件匣
const ex = join(root, 'My Drive @ Me', 'A & B 交換區'); const ledger = join(root, 'read.md');
mkdirSync(join(ex, '收件匣-乙'), { recursive: true }); mkdirSync(join(ex, '收件匣-甲'), { recursive: true }); mkdirSync(join(ex, '公告板'), { recursive: true });
writeFileSync(join(ex, '收件匣-乙', '訊息_甲→乙_報表放哪_2026-09-20.md'), '---\nfrom: 甲\n---\n');
writeFileSync(join(ex, '收件匣-乙', '請求_甲→乙_幫我看合約_2026-09-21.md'), '---\nfrom: 甲\n---\n');
writeFileSync(join(ex, '收件匣-乙', '訊息_丙→乙_報表放哪_2026-09-19.md'), '---\nfrom: 丙\n---\n'); // 同主題、不同寄件人
const exchanges = [{ id: null, ledgerPath: ledger, exchangePath: ex, name: '乙', configPath: join(root, 'nope.md') }];
const reply = join(ex, '收件匣-甲', '回執_報表放哪_乙_2026-09-22.md');
writeFileSync(reply, '---\nfrom: 乙\n---\n');

let r = autoReadOnReply(reply, { exchanges, dryRun: true });
eq('dryRun：回會記哪些、不寫帳', [r.marked, r.dryRun, existsSync(ledger)], [['訊息_甲→乙_報表放哪_2026-09-20.md'], true, false]);
r = autoReadOnReply(reply, { exchanges });
eq('回執寫出：原訊息被記帳', r.marked, ['訊息_甲→乙_報表放哪_2026-09-20.md']);
eq('回執寫出：同主題但別人寄的不動', r.marked.includes('訊息_丙→乙_報表放哪_2026-09-19.md'), false);
eq('記在該交換區的帳上', existsSync(ledger), true);
eq('註記寫明是哪一份回執', readFileSync(ledger, 'utf8').includes('已回執（回執_報表放哪_乙_2026-09-22.md）'), true);
r = autoReadOnReply(reply, { exchanges });
eq('再跑一次：冪等，不重複記', [r.marked, r.alreadyMarked], [[], ['訊息_甲→乙_報表放哪_2026-09-20.md']]);

const reply2 = join(ex, '收件匣-甲', '回執_幫我看合約_乙_2026-09-22.md'); writeFileSync(reply2, '');
eq('請求也算原訊息', autoReadOnReply(reply2, { exchanges }).marked, ['請求_甲→乙_幫我看合約_2026-09-21.md']);

// 不該動的情況
eq('不是回執：不動', autoReadOnReply(join(ex, '收件匣-甲', '訊息_乙→甲_另一件事_2026-09-22.md'), { exchanges }).marked, []);
eq('原訊息不存在：不猜', autoReadOnReply(join(ex, '收件匣-甲', '回執_沒這件事_乙_2026-09-22.md'), { exchanges }).marked, []);
eq('回執寫在自己的收件匣：不動', autoReadOnReply(join(ex, '收件匣-乙', '回執_報表放哪_乙_2026-09-22.md'), { exchanges }).reason, '回執寫在自己的收件匣');
eq('不在掛著的交換區裡：不動', autoReadOnReply(join(root, 'other', '收件匣-甲', '回執_報表放哪_乙_2026-09-22.md'), { exchanges }).reason, '不在任何掛著的交換區裡');
eq('寫在公告板：不動', autoReadOnReply(join(ex, '公告板', '回執_報表放哪_乙_2026-09-22.md'), { exchanges }).reason, '不在收件匣裡');
if (WIN) eq('Windows：正斜線寫法的路徑也認得', autoReadOnReply(reply.replace(/\\/g, '/'), { exchanges }).alreadyMarked?.length ?? -1, 1);

// 多交換區：記到對的帳上
const ex2 = join(root, 'ex2'); const ledger2 = join(root, 'read2.md');
mkdirSync(join(ex2, '收件匣-乙'), { recursive: true }); mkdirSync(join(ex2, '收件匣-戊'), { recursive: true });
writeFileSync(join(ex2, '收件匣-乙', '訊息_戊→乙_報表放哪_2026-09-20.md'), '');
const both = [...exchanges, { id: '二號', ledgerPath: ledger2, exchangePath: ex2, name: '乙', configPath: join(root, 'nope2.md') }];
r = autoReadOnReply(join(ex2, '收件匣-戊', '回執_報表放哪_乙_2026-09-22.md'), { exchanges: both });
eq('第二個交換區：記到它自己的帳', [r.exchangeId, r.marked], ['二號', ['訊息_戊→乙_報表放哪_2026-09-20.md']]);
eq('第二個交換區：預設區的帳沒被動到', readFileSync(ledger, 'utf8').includes('戊'), false);

// 從工具輸入撈路徑：Write／Edit
eq('Write 的 file_path 是回執：撈到', replyPathsFromTool('Write', { file_path: join(ex, '收件匣-甲', '回執_a_乙_2026-09-22.md') }).length, 1);
eq('Write 的 file_path 不是回執：不撈', replyPathsFromTool('Write', { file_path: join(ex, '收件匣-甲', '訊息_乙→甲_a_2026-09-22.md') }), []);
eq('其他工具：空', replyPathsFromTool('Read', { file_path: '回執_x_y_2026-01-01.md' }), []);
eq('沒有 tool_input：空', replyPathsFromTool('Write', undefined), []);

// 從工具輸入撈路徑：Bash——根目錄帶空白與 &，用根目錄比對而不是猜邊界
const want = join(ex, '收件匣-甲', '回執_報表放哪_乙_2026-09-22.md');
const fwd = ex.replace(/\\/g, '/');
eq('Bash：heredoc 寫入、路徑含空白與 &（斜線寫法）', replyPathsFromTool('Bash', { command: `cat > "${fwd}/收件匣-甲/回執_報表放哪_乙_2026-09-22.md" <<'EOF'\n---\nEOF` }, { exchanges }), [want]);
eq('Bash：cp 到收件匣（照設定檔原樣寫法）', replyPathsFromTool('Bash', { command: `cp draft.md "${ex}${WIN ? '\\' : '/'}收件匣-甲${WIN ? '\\' : '/'}回執_報表放哪_乙_2026-09-22.md"` }, { exchanges }), [want]);
eq('Bash：同一指令兩個回執都撈到', replyPathsFromTool('Bash', { command: `cp a "${fwd}/收件匣-甲/回執_x_乙_2026-09-22.md" && cp b "${fwd}/收件匣-甲/回執_y_乙_2026-09-22.md"` }, { exchanges }).length, 2);
eq('Bash：不是回執檔：不撈', replyPathsFromTool('Bash', { command: `cat > "${fwd}/收件匣-甲/訊息_乙→甲_x_2026-09-22.md"` }, { exchanges }), []);
eq('Bash：根目錄相同但不在收件匣：不撈', replyPathsFromTool('Bash', { command: `cat > "${fwd}/公告板/回執_x_乙_2026-09-22.md"` }, { exchanges }), []);
eq('Bash：用 shell 變數組的路徑撈不到（已知限制）', replyPathsFromTool('Bash', { command: `cat > "$EX/收件匣-甲/回執_報表放哪_乙_2026-09-22.md"` }, { exchanges }), []);
eq('Bash：指令沒提到回執：空', replyPathsFromTool('Bash', { command: `ls "${fwd}/收件匣-甲/"` }, { exchanges }), []);
if (WIN) {
  const gitBash = fwd.replace(/^([A-Za-z]):\//, (_, d) => `/${d.toLowerCase()}/`);
  eq('Windows：Git Bash 的 /c/… 寫法也對得到根目錄', replyPathsFromTool('Bash', { command: `cat > "${gitBash}/收件匣-甲/回執_報表放哪_乙_2026-09-22.md"` }, { exchanges }), [want]);
  eq('rootVariants：Windows 根目錄有三種寫法', rootVariants('C:\\Users\\U\\My Drive\\交換區').length, 3);
} else {
  eq('rootVariants：POSIX 根目錄只有一種寫法', rootVariants('/Users/u/My Drive/交換區').length, 1);
}

console.log(`\n${n - fail}/${n} 通過`);
rmSync(root, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
