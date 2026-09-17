// 單機認領鎖的驗收測試。跑法：node tests/claim.test.mjs
// 測試資料寫在系統暫存目錄，不碰真實 data dir。
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
// 動態 import 要轉 file:// URL，否則 Windows 絕對路徑的 C: 會被當成 protocol
const { claim, TAKEOVER_MS } = await import(pathToFileURL(join(HERE, '..', 'scripts', 'claim.mjs')).href);
const root = join(tmpdir(), 'mailbox-radar-claim-test');
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const sockDir = join(root, 'socks'); mkdirSync(sockDir);
// 用普通檔冒充活 socket——socketAlive 只看 existsSync，兩個平台都一樣。
// 併發測試的假 socket **必須真的存在**（writeFileSync 建空檔），否則輸家全判 holder 死而接管、
// 8 個全贏，那是測試設計錯不是鎖錯。
const liveA = join(sockDir, 'a.sock'); writeFileSync(liveA, '');
const liveB = join(sockDir, 'b.sock'); writeFileSync(liveB, '');

let n = 0, fail = 0;
function eq(name, got, want) { n++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) { fail++; console.log(`✗ ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); } else console.log(`✓ ${name}`); }

// 1. 首次認領成功
let r = claim('訊息_X→Y_甲_2026-09-02.md', { dataDir: root, sock: liveA });
eq('首次認領 won', r.won, true); eq('首次 reason', r.reason, 'claimed');
// 2. 別的活 session 來搶 → 輸
r = claim('訊息_X→Y_甲_2026-09-02.md', { dataDir: root, sock: liveB });
eq('活 holder 在 → 輸', r.won, false); eq('輸 reason', r.reason, 'held'); eq('holder 是 A', r.holder.sock, liveA);
// 3. 自己重跑 → 仍贏（idempotent）
r = claim('/some/abs/path/訊息_X→Y_甲_2026-09-02.md', { dataDir: root, sock: liveA });
eq('自己重跑 won', r.won, true); eq('own reason', r.reason, 'own');
// 4. holder 死了（socket 消失）→ 立刻接管
rmSync(liveA);
r = claim('訊息_X→Y_甲_2026-09-02.md', { dataDir: root, sock: liveB });
eq('holder 死 → 接管', r.won, true); eq('接管 reason', r.reason, 'takeover:holder-dead');
eq('票換成 B', JSON.parse(readFileSync(r.claimFile, 'utf8')).sock, liveB);
// 5. holder 活著但超過 15 分鐘 → 後備接管
writeFileSync(liveA, '');
claim('訊息_乙.md', { dataDir: root, sock: liveA, now: Date.now() - TAKEOVER_MS - 1000 });
r = claim('訊息_乙.md', { dataDir: root, sock: liveB });
eq('逾時 → 接管', r.won, true); eq('逾時 reason', r.reason, 'takeover:timeout');
// 6. holder 活著且 14 分鐘 → 仍輸
claim('訊息_丙.md', { dataDir: root, sock: liveA, now: Date.now() - TAKEOVER_MS + 60_000 });
r = claim('訊息_丙.md', { dataDir: root, sock: liveB });
eq('14 分鐘 → 仍輸', r.won, false);
// 7. holder sock 未知（null）→ 不知道活不活，只能靠逾時
claim('訊息_丁.md', { dataDir: root, sock: null });
r = claim('訊息_丁.md', { dataDir: root, sock: liveB });
eq('holder 未知且未逾時 → 輸', r.won, false);
// 8. 併發：8 個行程同一毫秒搶同一封，恰一個贏
const script = join(HERE, '..', 'scripts', 'claim.mjs');
for (let i = 0; i < 8; i++) writeFileSync(join(sockDir, `p${i}.sock`), ''); // 8 個活 session
const results = await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise((res) => {
  const c = spawn(process.execPath, [script, '訊息_併發.md'], {
    env: { ...process.env, MAILBOX_RADAR_DATA: root, CLAUDE_CODE_MESSAGING_SOCKET: join(sockDir, `p${i}.sock`) },
  });
  let out = ''; c.stdout.on('data', (d) => { out += d; }); c.on('close', () => res(out.trim()));
})));
const wins = results.map((o) => { try { return JSON.parse(o).won; } catch { return 'parse-fail:' + o; } });
eq('併發 8 搶 → 恰一勝', wins.filter((w) => w === true).length, 1);
eq('併發無解析失敗', wins.filter((w) => typeof w === 'string').length, 0);
const claimed = results.filter((o) => o.includes('"claimed"')).length;
eq('恰一個 claimed', claimed, 1);

// 9. 命令列解析：旗標的值不能被當成訊息檔；看不懂的參數一律不猜
const { parseClaimArgs } = await import(pathToFileURL(script).href);
let a = parseClaimArgs(['--exchange', '雙機', '訊息_甲.md']);
eq('旗標在前：目標是檔名不是旗標的值', a.target, '訊息_甲.md'); eq('旗標在前：交換區讀到', a.exchangeId, '雙機'); eq('旗標在前：沒有錯誤', a.error, null);
a = parseClaimArgs(['訊息_甲.md', '--exchange', '雙機']);
eq('旗標在後：目標', a.target, '訊息_甲.md'); eq('旗標在後：交換區', a.exchangeId, '雙機');
a = parseClaimArgs(['--data', '/tmp/x', '訊息_甲.md']);
eq('--data 的值不會被當成目標', a.target, '訊息_甲.md');
eq('不認得的旗標 → 報錯', parseClaimArgs(['--exchagne', '雙機', '訊息_甲.md']).error !== null, true);
eq('旗標沒給值 → 報錯', parseClaimArgs(['訊息_甲.md', '--exchange']).error !== null, true);
eq('兩個檔名 → 報錯', parseClaimArgs(['訊息_甲.md', '訊息_乙.md']).error !== null, true);
eq('什麼都沒給 → 報錯', parseClaimArgs([]).error !== null, true);
// 實際跑命令列：錯的參數要 exit 2、不建票
const { spawnSync } = await import('node:child_process');
const { existsSync } = await import('node:fs');
const cliEnv = { ...process.env, MAILBOX_RADAR_DATA: root, CLAUDE_CODE_MESSAGING_SOCKET: liveA };
let cli = spawnSync(process.execPath, [script, '--nope', '訊息_旗標錯.md'], { env: cliEnv, encoding: 'utf8' });
eq('命令列：不認得的旗標 exit 2', cli.status, 2);
eq('命令列：不認得的旗標不建票', existsSync(join(root, 'claims', '訊息_旗標錯.md.claim')), false);
cli = spawnSync(process.execPath, [script, '--exchange', '不存在的交換區', '訊息_區名錯.md'], { env: cliEnv, encoding: 'utf8' });
eq('命令列：交換區名稱不存在 exit 2', cli.status, 2);
eq('命令列：交換區名稱不存在不建票', existsSync(join(root, 'claims', '不存在的交換區__訊息_區名錯.md.claim')), false);
// 函式層：指定交換區時票名帶前綴，跟預設交換區的同名檔不搶同一張票
const k1 = claim('訊息_同名.md', { dataDir: root, sock: liveA, exchangeId: '雙機' });
const k2 = claim('訊息_同名.md', { dataDir: root, sock: liveB });
eq('同名檔、不同交換區：兩張票都拿得到', k1.won && k2.won, true);
eq('同名檔、不同交換區：票名不同', k1.claimFile !== k2.claimFile, true);

console.log(`\n${n - fail}/${n} 通過`);
rmSync(root, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
