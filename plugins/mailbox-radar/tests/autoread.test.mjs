// 「寫出回執就把原訊息記進已讀帳」的驗收測試。跑法：node tests/autoread.test.mjs
// 測試資料寫在系統暫存目錄，不碰真實 data dir 與真實交換區。
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const { autoReadOnReply, replyPathsFromTool } = await import(pathToFileURL(join(HERE, '..', 'scripts', 'autoread.mjs')).href);
const root = join(tmpdir(), 'mailbox-radar-autoread-test');
rmSync(root, { recursive: true, force: true });

let n = 0, fail = 0;
function eq(name, got, want) { n++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) { fail++; console.log(`✗ ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); } else console.log(`✓ ${name}`); }

// 假交換區：我是「乙」，甲寄信給我，我回執到甲的收件匣
const ex = join(root, 'ex'); const ledger = join(root, 'read.md');
mkdirSync(join(ex, '收件匣-乙'), { recursive: true }); mkdirSync(join(ex, '收件匣-甲'), { recursive: true }); mkdirSync(join(ex, '公告板'), { recursive: true });
writeFileSync(join(ex, '收件匣-乙', '訊息_甲→乙_報表放哪_2026-09-20.md'), '---\nfrom: 甲\n---\n');
writeFileSync(join(ex, '收件匣-乙', '請求_甲→乙_幫我看合約_2026-09-21.md'), '---\nfrom: 甲\n---\n');
writeFileSync(join(ex, '收件匣-乙', '訊息_丙→乙_報表放哪_2026-09-19.md'), '---\nfrom: 丙\n---\n'); // 同主題、不同寄件人
const exchanges = [{ id: null, ledgerPath: ledger, exchangePath: ex, name: '乙', configPath: join(root, 'nope.md') }];
const reply = join(ex, '收件匣-甲', '回執_報表放哪_乙_2026-09-22.md');
writeFileSync(reply, '---\nfrom: 乙\n---\n');

let r = autoReadOnReply(reply, { exchanges });
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
eq('Windows 反斜線路徑也認得', autoReadOnReply(reply.replace(/\//g, '\\'), { exchanges }).alreadyMarked?.length ?? -1, 1);

// 多交換區：記到對的帳上
const ex2 = join(root, 'ex2'); const ledger2 = join(root, 'read2.md');
mkdirSync(join(ex2, '收件匣-乙'), { recursive: true }); mkdirSync(join(ex2, '收件匣-戊'), { recursive: true });
writeFileSync(join(ex2, '收件匣-乙', '訊息_戊→乙_報表放哪_2026-09-20.md'), '');
const both = [...exchanges, { id: '二號', ledgerPath: ledger2, exchangePath: ex2, name: '乙', configPath: join(root, 'nope2.md') }];
r = autoReadOnReply(join(ex2, '收件匣-戊', '回執_報表放哪_乙_2026-09-22.md'), { exchanges: both });
eq('第二個交換區：記到它自己的帳', [r.exchangeId, r.marked], ['二號', ['訊息_戊→乙_報表放哪_2026-09-20.md']]);
eq('第二個交換區：預設區的帳沒被動到', readFileSync(ledger, 'utf8').includes('戊'), false);

// 從工具輸入撈路徑
eq('Write 的 file_path 是回執：撈到', replyPathsFromTool('Write', { file_path: 'C:\\x\\收件匣-甲\\回執_a_乙_2026-09-22.md' }).length, 1);
eq('Write 的 file_path 不是回執：不撈', replyPathsFromTool('Write', { file_path: 'C:\\x\\收件匣-甲\\訊息_乙→甲_a_2026-09-22.md' }), []);
eq('Bash 指令裡的回執路徑：撈到', replyPathsFromTool('Bash', { command: 'cat > "/i/我的雲端硬碟/交換區/收件匣-Mac/回執_請確認_Windows_2026-09-21.md" <<EOF' }), ['/i/我的雲端硬碟/交換區/收件匣-Mac/回執_請確認_Windows_2026-09-21.md']);
eq('Bash 指令沒有回執路徑：空', replyPathsFromTool('Bash', { command: 'ls 收件匣-Mac/' }), []);
eq('其他工具：空', replyPathsFromTool('Read', { file_path: '回執_x_y_2026-01-01.md' }), []);
eq('沒有 tool_input：空', replyPathsFromTool('Write', undefined), []);

console.log(`\n${n - fail}/${n} 通過`);
rmSync(root, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
