// 「新訊息該叫醒哪個對話」的驗收測試。跑法：node tests/attention.test.mjs
// 測試資料寫在系統暫存目錄，不碰真實 data dir。
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const A = await import(pathToFileURL(join(HERE, '..', 'scripts', 'attention.mjs')).href);
const { chooseNotified, countsAsActivity, recordActivity, readActivities, sweepActivities, projectKey, WARM_MS, RADAR_PREFIX } = A;
const root = join(tmpdir(), 'mailbox-radar-attention-test');
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

let n = 0, fail = 0;
function eq(name, got, want) { n++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) { fail++; console.log(`✗ ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); } else console.log(`✓ ${name}`); }

const now = Date.parse('2026-09-21T10:00:00Z');
const min = 60_000;
const pick = (me, sessions) => chooseNotified(me, sessions, { now }).notify;
/** 哪些對話會發通知（每支 watcher 各自判斷一次，模擬真實情況） */
const winners = (sessions) => sessions.map((s) => s.session).filter((me) => pick(me, sessions)).sort();

// ── 回報的原始情境：對話 1 做完收尾，使用者在同一個專案新開對話 2 ──
let ss = [
  { session: 'conv1', at: now - 5 * min, cwd: '/proj/A' },
  { session: 'conv2', at: now - 1 * min, cwd: '/proj/A' },
];
eq('同專案：只有最後動的對話 2 發', winners(ss), ['conv2']);
eq('同專案：舊的對話 1 安靜', pick('conv1', ss), false);

// ── 優先規則：每個專案各一個 ──
ss = [
  { session: 'a1', at: now - 50 * min, cwd: '/proj/A' },
  { session: 'a2', at: now - 10 * min, cwd: '/proj/A' },
  { session: 'b1', at: now - 30 * min, cwd: '/proj/B' },
  { session: 'c-cold', at: now - 3 * 60 * min, cwd: '/proj/C' },
  { session: 'a-cold', at: now - 2 * 60 * min, cwd: '/proj/A' },
];
eq('兩個有人在用的專案：各叫醒一個', winners(ss), ['a2', 'b1']);
eq('超過一小時的專案 C 不叫醒', pick('c-cold', ss), false);
eq('規則名稱是 warm', chooseNotified('a2', ss, { now }).rule, 'warm');
eq('剛好一小時整還算', winners([{ session: 'x', at: now - WARM_MS, cwd: '/p' }, { session: 'y', at: now - 5 * 60 * min, cwd: '/p' }]), ['x']);

// ── 備援：一小時內沒有任何對話有人動過 → 全機只叫醒一個 ──
ss = [
  { session: 'a1', at: now - 5 * 60 * min, cwd: '/proj/A' },
  { session: 'b1', at: now - 2 * 60 * min, cwd: '/proj/B' },
  { session: 'c1', at: now - 9 * 60 * min, cwd: '/proj/C' },
];
eq('無人情境：跨專案只選最後動過的那一個', winners(ss), ['b1']);
eq('規則名稱是 fallback', chooseNotified('b1', ss, { now }).rule, 'fallback');

// 沒有活動紀錄的對話（升級前就開著的）：用 watcher 啟動時刻排序
ss = [
  { session: 'old1', at: null, cwd: null, startedAt: now - 8 * 60 * min },
  { session: 'old2', at: null, cwd: null, startedAt: now - 3 * 60 * min },
  { session: 'old3', at: null, cwd: null },
];
eq('全都沒紀錄：用啟動時刻選一個', winners(ss), ['old2']);
eq('全都沒紀錄也沒啟動時刻：仍然恰好一個', winners([{ session: 'p', at: null, cwd: null }, { session: 'q', at: null, cwd: null }]).length, 1);
// 有紀錄但過期的，與沒紀錄的混在一起
ss = [{ session: 'm1', at: now - 4 * 60 * min, cwd: '/x' }, { session: 'm2', at: null, cwd: null, startedAt: now - 2 * 60 * min }];
eq('過期紀錄 vs 較新的啟動時刻：選較新的', winners(ss), ['m2']);
// 一個有人在用、其他沒紀錄 → 沒紀錄的不發
ss = [{ session: 'w', at: now - 2 * min, cwd: '/x' }, { session: 'nolog', at: null, cwd: null, startedAt: now }];
eq('有人在用時，沒紀錄的對話不發', winners(ss), ['w']);

// ── 邊界 ──
eq('全機只有我一個：一定發', chooseNotified('solo', [{ session: 'solo', at: null, cwd: null }], { now }), { notify: true, rule: 'solo', winner: 'solo' });
eq('候選名單漏了我（心跳還沒寫）：補進去再判', chooseNotified('me', [], { now }).notify, true);
ss = [{ session: 't1', at: now - min, cwd: '/p' }, { session: 't2', at: now - min, cwd: '/p' }];
eq('同一毫秒：仍然恰好一個', winners(ss).length, 1);
eq('同一毫秒：兩支 watcher 的結論一致', chooseNotified('t1', ss, { now }).winner, chooseNotified('t2', ss, { now }).winner);
ss = [{ session: 'f', at: now + 10 * 60 * min, cwd: '/p' }, { session: 'g', at: now - min, cwd: '/p' }];
eq('時鐘錯亂寫出未來時間的紀錄不算熱', winners(ss), ['g']);
ss = [{ session: 'n1', at: now - min, cwd: null }, { session: 'n2', at: now - 2 * min, cwd: null }, { session: 'n3', at: now - 3 * min, cwd: '/p' }];
eq('沒有資料夾資訊的對話自成一組', winners(ss), ['n1', 'n3']);

// 資料夾比較鍵
eq('結尾斜線不影響分組', projectKey('/proj/A/'), projectKey('/proj/A'));
if (process.platform === 'win32') eq('Windows 路徑不分大小寫', projectKey('C:\\Proj\\A'), projectKey('c:/proj/a'));
else eq('非 Windows 路徑分大小寫', projectKey('/Proj/A') === projectKey('/proj/a'), false);
eq('空資料夾回空字串', projectKey(null), '');

// ── 什麼算「人動了這個對話」 ──
eq('使用者送出訊息：算', countsAsActivity('UserPromptSubmit', { prompt: '幫我看一下' }), true);
eq('雷達自己送的通知：不算', countsAsActivity('UserPromptSubmit', { prompt: `${RADAR_PREFIX} 2026-09-21T08:39:03Z】新訊息落地 1 筆` }), false);
eq('雷達通知前面有空白：不算', countsAsActivity('UserPromptSubmit', { prompt: `\n  ${RADAR_PREFIX}】` }), false);
eq('宿主在前面加了一行說明：不算', countsAsActivity('UserPromptSubmit', { prompt: `Another Claude session sent a message:
${RADAR_PREFIX} x】新訊息落地 1 筆` }), false);
eq('使用者在長訊息後段引用到雷達字樣：算', countsAsActivity('UserPromptSubmit', { prompt: `${'這是一段很長的說明。'.repeat(30)}剛剛那個${RADAR_PREFIX}是什麼` }), true);
eq('背景指令結束的宿主通知：不算', countsAsActivity('UserPromptSubmit', { prompt: '<task-notification>\n<task-id>abc</task-id>\n<status>completed</status>\n</task-notification>' }), false);
eq('宿主的系統提醒：不算', countsAsActivity('UserPromptSubmit', { prompt: '  <system-reminder>日期已變更</system-reminder>' }), false);
eq('帶屬性的標籤開頭：不算', countsAsActivity('UserPromptSubmit', { prompt: '<ci-monitor-event pr="12">失敗</ci-monitor-event>' }), false);
eq('別的對話送來的訊息（不是雷達）：不算', countsAsActivity('UserPromptSubmit', { prompt: 'Another Claude session sent a message:\n請幫我看一下這個檔' }), false);
eq('人打的訊息裡面有標籤但不在開頭：算', countsAsActivity('UserPromptSubmit', { prompt: '這段 <div> 為什麼不會置中？' }), true);
eq('人打的小於符號開頭但不是標籤：算', countsAsActivity('UserPromptSubmit', { prompt: '< 3 的情況要怎麼處理' }), true);
eq('人打的斜線指令：算', countsAsActivity('UserPromptSubmit', { prompt: '/handoff' }), true);
eq('沒有 prompt 欄位：算（寧可多記）', countsAsActivity('UserPromptSubmit', {}), true);
eq('新開對話：算', countsAsActivity('SessionStart', { source: 'startup' }), true);
eq('接續對話：算', countsAsActivity('SessionStart', { source: 'resume' }), true);
eq('壓縮後重來：不算', countsAsActivity('SessionStart', { source: 'compact' }), false);
eq('工具呼叫：不算', countsAsActivity('PostToolUse', {}), false);

// ── 落檔、讀回、清掃 ──
eq('記一筆成功', recordActivity(root, 'sess/1:x', { cwd: '/proj/A', kind: 'UserPromptSubmit', at: now }), true);
recordActivity(root, 'sess2', { cwd: '/proj/B', kind: 'SessionStart', at: now - min });
let acts = readActivities(root);
eq('讀回兩筆', acts.size, 2);
eq('session id 裡的怪字元被換掉', acts.has('sess_1_x'), true);
eq('時間與資料夾讀得回來', acts.get('sess_1_x'), { at: now, cwd: '/proj/A' });
recordActivity(root, 'sess2', { cwd: '/proj/B', kind: 'UserPromptSubmit', at: now });
eq('同一個對話再記一次是覆蓋不是新增', readActivities(root).size, 2);
eq('覆蓋後時間更新', readActivities(root).get('sess2').at, now);
eq('清掃：不在名冊上的被清掉', sweepActivities(root, new Set(['sess2'])), 1);
eq('清掃後只剩名冊上的', [...readActivities(root).keys()], ['sess2']);
eq('資料夾不存在時讀回空', readActivities(join(root, 'nope')).size, 0);
eq('資料夾不存在時清掃回 0', sweepActivities(join(root, 'nope'), new Set()), 0);

// ── 對照對話紀錄裡的來源欄位（0.7.7）──
// 假的對話紀錄：形狀照實際擷取到的紀錄縮寫，只留判斷用得到的欄位。
const { originOf, settleActivity } = A;
const tdir = join(root, 'transcripts'); mkdirSync(tdir, { recursive: true });
const T0 = Date.parse('2026-09-21T09:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const lines = [
  { type: 'user', timestamp: iso(T0), origin: { kind: 'human' }, message: { content: '幫我看一下' } },
  { type: 'assistant', timestamp: iso(T0 + 1000), message: { content: [] } },
  { type: 'user', timestamp: iso(T0 + 2000), message: { content: [{ type: 'tool_result', content: 'x' }] } },
  // 閒置時別的對話送來：有包裝行，origin 是 peer
  { type: 'user', timestamp: iso(T0 + 60_000), isMeta: true, origin: { kind: 'peer', from: 'unknown' }, message: { content: 'Another Claude session sent a message:\n請幫我看一下第 40 行' } },
  // 正在跑的時候別的對話送來：排隊紀錄，prompt 是原文、沒有包裝行——光看內容分不出來的那一種
  { type: 'attachment', timestamp: iso(T0 + 125_000), attachment: { type: 'queued_command', commandMode: 'prompt', prompt: '請幫我看一下第 40 行', origin: { kind: 'peer' }, isMeta: true, timestamp: iso(T0 + 120_000) } },
  // 正在跑的時候人自己打字：同樣是排隊紀錄，origin 是 human
  { type: 'attachment', timestamp: iso(T0 + 185_000), attachment: { type: 'queued_command', commandMode: 'prompt', prompt: '等一下，先不要推', origin: { kind: 'human' }, timestamp: iso(T0 + 180_000) } },
  // 背景指令結束：排隊紀錄，沒有 origin，靠 commandMode 認
  { type: 'attachment', timestamp: iso(T0 + 240_000), attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: '<task-notification>', timestamp: iso(T0 + 240_000) } },
  // 排程自動觸發：內容跟人打的一樣，沒有 origin，isMeta 是 true
  { type: 'user', timestamp: iso(T0 + 300_000), isMeta: true, message: { content: '例行推進：檢查昨天的結果' } },
  // 沒有 origin 也不是 isMeta：舊版宿主寫的人為提示，當成人打的
  { type: 'user', timestamp: iso(T0 + 360_000), message: { content: '/model' } },
];
const tfile = join(tdir, 't1.jsonl');
const { writeFileSync: wf, appendFileSync: af } = await import('node:fs');
wf(tfile, lines.map((l) => JSON.stringify(l)).join('\n') + '\n不是 JSON 的一行\n');
eq('來源：人打的', originOf(tfile, T0 + 300), 'human');
eq('來源：閒置時別的對話送來', originOf(tfile, T0 + 60_200), 'machine');
eq('來源：正在跑時別的對話送來（內容分不出來的那種）', originOf(tfile, T0 + 120_100), 'machine');
eq('來源：排隊紀錄兩個時間都認（出隊時刻）', originOf(tfile, T0 + 125_050), 'machine');
eq('來源：正在跑時人自己打字', originOf(tfile, T0 + 180_400), 'human');
eq('來源：背景指令結束', originOf(tfile, T0 + 240_000), 'machine');
eq('來源：排程自動觸發', originOf(tfile, T0 + 300_000), 'machine');
eq('來源：舊版紀錄沒有來源欄位，當成人打的', originOf(tfile, T0 + 360_000), 'human');
eq('來源：工具結果不算提示，附近沒有別的就是查不到', originOf(tfile, T0 + 2000, { toleranceMs: 500 }), 'unknown');
eq('來源：時間對不上任何一則', originOf(tfile, T0 + 30_000), 'unknown');
eq('來源：檔案不存在', originOf(join(tdir, 'nope.jsonl'), T0), 'unknown');
eq('來源：沒給路徑', originOf(null, T0), 'unknown');
// 檔尾讀取：前面塞超過讀取上限的內容，開頭那則就查不到了，檔尾那則仍查得到
const big = join(tdir, 'big.jsonl');
wf(big, JSON.stringify(lines[0]) + '\n');
const filler = JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(100_000) } }) + '\n';
for (let i = 0; i < 17; i++) af(big, filler);
af(big, JSON.stringify(lines[3]) + '\n');
eq('大檔：檔尾那則查得到', originOf(big, T0 + 60_000), 'machine');
eq('大檔：超出檔尾範圍的回查不到（不是亂猜）', originOf(big, T0), 'unknown');

// 待確認 → 讀取時即時判斷
const d3 = join(root, 'pend'); mkdirSync(d3, { recursive: true });
recordActivity(d3, 'p1', { cwd: '/proj/A', kind: 'SessionStart', at: T0 - 600_000 });
recordActivity(d3, 'p1', { cwd: '/proj/A', kind: 'UserPromptSubmit', at: T0 + 120_100, transcript: tfile }); // 其實是別的對話送的
eq('待確認的是程式產生的：有效時間停在開場那一筆', readActivities(d3).get('p1').at, T0 - 600_000);
recordActivity(d3, 'p1', { cwd: '/proj/A2', kind: 'UserPromptSubmit', at: T0 + 180_400, transcript: tfile }); // 人打的
eq('待確認的是人打的：有效時間前進', readActivities(d3).get('p1'), { at: T0 + 180_400, cwd: '/proj/A2' });
recordActivity(d3, 'p1', { cwd: '/proj/A', kind: 'UserPromptSubmit', at: T0 + 240_000, transcript: tfile }); // 背景指令結束
eq('後面又來一則程式產生的：有效時間不動', readActivities(d3).get('p1').at, T0 + 180_400);
recordActivity(d3, 'p2', { cwd: '/proj/B', kind: 'UserPromptSubmit', at: T0 + 30_000, transcript: tfile }); // 查不到
eq('查不到的當成人打的（退回內容比對的結果）', readActivities(d3).get('p2').at, T0 + 30_000);

// 結算：寫回檔案
let tl = settleActivity(d3, 'p1', { now: T0 + 300_000 });
eq('結算：一則人打的、兩則程式產生的', [tl.human, tl.machine, tl.kept], [1, 2, 0]);
let saved = JSON.parse(readFileSync(join(d3, 'activity', 'p1.json'), 'utf8'));
eq('結算後：確認時間是人打的那一則', saved.at, iso(T0 + 180_400));
eq('結算後：資料夾跟著那一則', saved.cwd, '/proj/A2');
eq('結算後：待確認清空', saved.pending, []);
eq('結算後再結算：沒事可做', settleActivity(d3, 'p1', { now: T0 + 400_000 }), { human: 0, machine: 0, kept: 0 });
tl = settleActivity(d3, 'p2', { now: T0 + 31_000 });
eq('剛記下、查不到的：先留著', [tl.human, tl.machine, tl.kept], [0, 0, 1]);
tl = settleActivity(d3, 'p2', { now: T0 + 30_000 + 121_000 });
eq('超過兩分鐘還查不到：當成人打的結掉', [tl.human, tl.machine, tl.kept], [1, 0, 0]);
recordActivity(d3, 'p3', { cwd: '/x', kind: 'UserPromptSubmit', at: T0 + 300, transcript: tfile });
tl = settleActivity(d3, 'p3', { now: T0 + 1000 });
eq('記下不到三秒的：不結算（對話紀錄可能還沒落檔）', tl.kept, 1);
for (let i = 0; i < 30; i++) recordActivity(d3, 'p4', { cwd: '/x', kind: 'UserPromptSubmit', at: T0 + 30_000 + i, transcript: tfile });
eq('待確認最多留 20 則', JSON.parse(readFileSync(join(d3, 'activity', 'p4.json'), 'utf8')).pending.length, 20);
eq('開場會蓋過舊的確認時間、不動待確認', (recordActivity(d3, 'p4', { cwd: '/y', kind: 'SessionStart', at: T0 + 999_000 }), JSON.parse(readFileSync(join(d3, 'activity', 'p4.json'), 'utf8')).pending.length), 20);

// ── hook 進場：UserPromptSubmit 要記帳、不輸出、秒退 ──
const inject = join(HERE, '..', 'scripts', 'inject.mjs');
const d2 = join(root, 'hookdata'); mkdirSync(d2, { recursive: true });
const run = (payload) => spawnSync(process.execPath, [inject, '--event', 'UserPromptSubmit', '--data', d2], { input: JSON.stringify(payload), encoding: 'utf8' });
let r = run({ session_id: 'hook-a', cwd: '/proj/Z', prompt: '你好' });
eq('hook：正常結束', r.status, 0);
eq('hook：不輸出任何東西（不往對話塞字）', r.stdout, '');
eq('hook：記下了活動', JSON.parse(readFileSync(join(d2, 'activity', 'hook-a.json'), 'utf8')).cwd, '/proj/Z');
r = run({ session_id: 'hook-b', cwd: '/proj/Z', prompt: `${RADAR_PREFIX} x】新訊息落地 1 筆` });
eq('hook：雷達通知不記帳', existsSync(join(d2, 'activity', 'hook-b.json')), false);
eq('hook：雷達通知也不輸出', r.stdout, '');

console.log(`\n${n - fail}/${n} 通過`);
rmSync(root, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
