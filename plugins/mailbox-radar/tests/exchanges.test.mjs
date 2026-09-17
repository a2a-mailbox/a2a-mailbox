// 多交換區的驗收測試。跑法：
//   node tests/exchanges.test.mjs
// 全部 assertion 過才 exit 0。測試資料寫在系統暫存目錄，不碰真實的 ~/.claude 與交換區。
//
// 要解的問題：一臺機器同時掛好幾個交換區，例如公司團隊一個、自己兩臺電腦互傳一個。
// 每個交換區有自己的代稱、成員名單與已讀帳；兩個交換區可能出現同名檔，所以任何
// 「記住看過哪些」的集合都不能只拿檔名當鍵。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..', 'scripts');
const root = join(tmpdir(), 'mailbox-radar-exchanges-test');
rmSync(root, { recursive: true, force: true });

// 模組載入時就讀環境變數，所以要在 import 之前設好；全部指到暫存區
const userDir = join(root, 'team-mailbox');
const dataDir = join(root, 'data');
process.env.TEAM_MAILBOX_USER_DATA = userDir;
process.env.TEAM_MAILBOX_LEGACY_DIR = join(root, 'legacy-none');
process.env.MAILBOX_RADAR_DATA = dataDir;
for (const k of ['MAILBOX_RADAR_CONFIG', 'MAILBOX_RADAR_LEDGER', 'MAILBOX_RADAR_CONTACTS',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN']) delete process.env[k];

const U = await import(pathToFileURL(join(SCRIPTS, 'userdata.mjs')).href);
const D = await import(pathToFileURL(join(SCRIPTS, 'detect.mjs')).href);
const F = await import(pathToFileURL(join(SCRIPTS, 'format.mjs')).href);
const { plan } = await import(pathToFileURL(join(SCRIPTS, 'deskbell.mjs')).href);
const { claim } = await import(pathToFileURL(join(SCRIPTS, 'claim.mjs')).href);

const pass = [];
const fail = [];
const ok = (name, cond, extra = '') => { (cond ? pass : fail).push(name); if (!cond) console.log(`FAIL  ${name}  ${extra}`); };
const run = (script, args, opts = {}) =>
  spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { env: process.env, encoding: 'utf8', ...opts });

// 兩個假交換區，公告板各放一個同名檔
const teamEx = join(root, 'drive', '_交換區');
const duoEx = join(root, 'drive', '_交換區-雙機');
for (const d of [join(teamEx, '收件匣-Alice'), join(teamEx, '公告板'), join(duoEx, '收件匣-Windows'), join(duoEx, '公告板')]) {
  mkdirSync(d, { recursive: true });
}
const SAME = '公告_同名公告_2026-09-02.md';
const DUO_MSG = '訊息_Mac→Windows_雙機事_2026-09-03.md';
writeFileSync(join(teamEx, '收件匣-Alice', '訊息_Jane→Alice_團隊事_2026-09-01.md'), 'x');
writeFileSync(join(teamEx, '公告板', SAME), 'x');
writeFileSync(join(duoEx, '收件匣-Windows', DUO_MSG), 'x');
writeFileSync(join(duoEx, '公告板', SAME), 'x');

mkdirSync(userDir, { recursive: true });
writeFileSync(join(userDir, 'config.md'), `名字：Alice\n交換區：${teamEx}\n`);

// ── 1. 只掛預設交換區：與 0.6.0 行為一致 ───────────────────────
{
  const list = U.listExchanges();
  ok('只掛一個：listExchanges 回一筆且 id 為 null', list.length === 1 && list[0].id === null);
  const r = D.detect();
  ok('只掛一個：偵測成功', r.ok, r.error ?? '');
  ok('只掛一個：未讀 2 筆', r.unreadCount === 2, `實際 ${r.unreadCount}`);
  ok('只掛一個：key 就是檔名、沒有交換區名稱（既有狀態檔不受影響）',
    r.arrivals.every((u) => u.key === u.file && u.exchangeId === null));
  ok('只掛一個：exchanges 只有預設那一筆', r.exchanges.length === 1 && r.exchanges[0].id === null && r.exchanges[0].ok);
  const text = F.formatUnread(r, { mode: 'session' }) ?? '';
  ok('只掛一個：開場文字維持原格式', /Alice 有 2 筆未讀（收件匣 1、公告板 1）/.test(text), text);
}

// ── 2. 加掛「雙機」交換區 ───────────────────────────────────────
const duoDir = join(userDir, '交換區', '雙機');
mkdirSync(duoDir, { recursive: true });
writeFileSync(join(duoDir, 'config.md'), `名字：Windows\n交換區：${duoEx}\n`);
mkdirSync(join(userDir, '交換區', '建到一半'), { recursive: true }); // 沒有 config.md，不算
{
  const list = U.listExchanges();
  ok('兩個：listExchanges 回兩筆，沒有 config 的資料夾不算',
    list.length === 2 && list[1].id === '雙機', JSON.stringify(list.map((x) => x.id)));
  ok('兩個：額外交換區的帳與通訊錄在自己的資料夾',
    list[1].ledgerPath === join(duoDir, 'read.md') && list[1].contactsPath === join(duoDir, '通訊錄.md'));
  ok('兩個：exchangePaths 依名稱找得到，找不到回 null',
    U.exchangePaths('雙機')?.dir === duoDir && U.exchangePaths(null)?.id === null && U.exchangePaths('不存在') === null);

  const r = D.detect();
  ok('兩個：未讀彙總成 4 筆', r.unreadCount === 4, `實際 ${r.unreadCount}`);
  ok('兩個：exchanges 兩筆都成功', r.exchanges.length === 2 && r.exchanges.every((x) => x.ok));
  ok('兩個：雙機那一區的代稱是 Windows', r.exchanges[1].name === 'Windows');
  const duo = r.arrivals.filter((u) => u.exchangeId === '雙機');
  ok('兩個：雙機的訊息帶交換區名稱', duo.length === 2);
  ok('兩個：雙機的 key 帶「雙機/」前綴', duo.every((u) => u.key === `雙機/${u.file}`));
  const same = r.arrivals.filter((u) => u.file === SAME);
  ok('兩個：同名公告兩區各算一筆、key 不同', same.length === 2 && new Set(same.map((u) => u.key)).size === 2);

  const text = F.formatUnread(r, { mode: 'session', limit: 8 }) ?? '';
  ok('兩個：開場標頭講總數與各區',
    /共 4 筆未讀/.test(text) && /Alice 有 2 筆/.test(text) && /交換區「雙機」（代稱 Windows）有 2 筆/.test(text), text);
  ok('兩個：雙機的訊息列出時標了交換區', /【雙機】訊息：Mac → 雙機事/.test(text), text);
}

// ── 3. 已讀帳各區獨立 ───────────────────────────────────────────
{
  writeFileSync(join(duoDir, 'read.md'), `- ${SAME}（已處理）\n`);
  const r = D.detect();
  const same = r.unread.filter((u) => u.file === SAME);
  ok('已讀帳獨立：只在雙機記過的同名公告，只從雙機消失',
    same.length === 1 && same[0].exchangeId === null, JSON.stringify(same.map((u) => u.key)));
  ok('已讀帳獨立：總數降成 3', r.unreadCount === 3, `實際 ${r.unreadCount}`);
}

// ── 4. 額外交換區讀不到：整體照常，錯誤只記在那一區 ─────────────
{
  const brokenDir = join(userDir, '交換區', '壞掉的');
  mkdirSync(brokenDir, { recursive: true });
  writeFileSync(join(brokenDir, 'config.md'), '名字：X\n'); // 缺交換區欄位
  const r = D.detect();
  ok('壞一區：整體仍是 ok', r.ok === true);
  const b = r.exchanges.find((x) => x.id === '壞掉的');
  ok('壞一區：那一區標成失敗並帶錯誤', b && b.ok === false && /缺欄位/.test(b.error ?? ''), JSON.stringify(b));
  ok('壞一區：其他區的未讀照樣算', r.unreadCount === 3);
  rmSync(brokenDir, { recursive: true, force: true });
}

// ── 5. 預設交換區沒設定：整體仍是「還沒裝好」──────────────────
{
  const saved = readFileSync(join(userDir, 'config.md'), 'utf8');
  rmSync(join(userDir, 'config.md'));
  const r = D.detect();
  ok('預設沒設定：整體 errorKind 是 config，就算額外交換區設好了', r.ok === false && r.errorKind === 'config');
  writeFileSync(join(userDir, 'config.md'), saved);
}

// ── 6. 訊息檔屬於哪個交換區 ─────────────────────────────────────
{
  ok('歸屬：雙機的檔判成雙機', D.exchangeForPath(join(duoEx, '收件匣-Windows', DUO_MSG))?.id === '雙機');
  const x0 = D.exchangeForPath(join(teamEx, '公告板', SAME));
  ok('歸屬：團隊的檔判成預設交換區', x0 !== null && x0.id === null, JSON.stringify(x0));
  ok('歸屬：「_交換區」不會誤吃「_交換區-雙機」（前綴相同但不是子路徑）',
    D.exchangeForPath(join(duoEx, 'x.md'))?.id === '雙機');
  ok('歸屬：交換區外的檔回 null', D.exchangeForPath(join(root, 'elsewhere', 'x.md')) === null);
  if (process.platform === 'win32') {
    ok('歸屬：Windows 路徑不分大小寫與斜線方向',
      D.exchangeForPath(join(duoEx, 'x.md').toUpperCase().replace(/\\/g, '/'))?.id === '雙機');
  }
}

// ── 7. 桌鈴 ─────────────────────────────────────────────────────
{
  const items = [
    { file: 'a.md', key: 'a.md', exchangeId: null, tracked: true },
    { file: 'a.md', key: '雙機/a.md', exchangeId: '雙機', tracked: true },
  ];
  const p = plan(items, { notified: {} }, 1000, { repeatMs: 100, tags: ['', '雙機'] });
  ok('桌鈴：同名檔兩區各算一筆', p.ring.length === 2);
  ok('桌鈴：記錄用 key 不用檔名', 'a.md' in p.state.notified && '雙機/a.md' in p.state.notified);

  // 舊狀態檔只有 seeded 布林 → 當成預設交換區建過基準
  const legacyState = { notified: { 'b.md': 900 }, seeded: true };
  const withNewEx = [
    { file: 'b.md', key: 'b.md', exchangeId: null, tracked: true },
    { file: 'old.md', key: '新區/old.md', exchangeId: '新區', tracked: false },
    { file: 'new-inbox.md', key: 'new-inbox.md', exchangeId: null, tracked: false },
  ];
  const q = plan(withNewEx, legacyState, 1000, { repeatMs: 1000, tags: ['', '新區'] });
  ok('桌鈴：舊狀態檔升級後，預設交換區新到的不追蹤檔照樣響', q.ring.some((u) => u.key === 'new-inbox.md'));
  ok('桌鈴：新掛上的交換區，不追蹤的舊檔只建基準不響',
    !q.ring.some((u) => u.key === '新區/old.md') && '新區/old.md' in q.state.notified);
  ok('桌鈴：之後兩區都記成建過基準', q.state.seededExchanges.includes('新區') && q.state.seededExchanges.includes(''));
}

// ── 8. 認領鎖：同名檔兩區各一張票 ───────────────────────────────
{
  const claimData = join(root, 'data-claim');
  const a = claim(join(teamEx, '公告板', SAME), { dataDir: claimData, sock: 'sock-A' });
  const b = claim(join(duoEx, '公告板', SAME), { dataDir: claimData, sock: 'sock-B' });
  ok('認領：團隊那封搶到', a.won === true);
  ok('認領：雙機的同名那封也搶得到，不被團隊那張票擋住', b.won === true, JSON.stringify(b));
  ok('認領：兩張票檔名不同', a.claimFile !== b.claimFile);
  ok('認領：預設交換區的票名維持純檔名（舊票照樣有效）',
    a.claimFile.split(/[\\/]/).pop() === `${SAME}.claim`, a.claimFile);
}

// ── 9. 命令列帶 --exchange ──────────────────────────────────────
{
  let r = run('markread.mjs', ['--exchange', '雙機', DUO_MSG]);
  ok('markread --exchange：exit 0', r.status === 0, r.stderr);
  const duoLedger = readFileSync(join(duoDir, 'read.md'), 'utf8');
  ok('markread --exchange：記進雙機的帳', duoLedger.includes(DUO_MSG));
  ok('markread --exchange：交換區名稱沒被當成檔名', !duoLedger.includes('- 雙機（'));
  ok('markread --exchange：預設交換區的帳沒被動',
    !existsSync(join(userDir, 'read.md')) || !readFileSync(join(userDir, 'read.md'), 'utf8').includes(DUO_MSG));
  r = run('markread.mjs', ['--exchange', '不存在', 'x.md']);
  ok('markread --exchange：找不到交換區 exit 1', r.status === 1);
  r = run('markread.mjs', ['--note', '已回覆', '--exchange', '雙機', '訊息_Mac→Windows_另一封_2026-09-04.md']);
  ok('markread：--note 與 --exchange 一起帶，兩個值都不會被當成檔名',
    r.status === 0 && JSON.parse(r.stdout).added.length === 1, r.stdout + r.stderr);

  r = run('contacts.mjs', ['add', 'owner@example.com', 'Mac、Windows', '--exchange', '雙機']);
  ok('contacts --exchange：exit 0', r.status === 0, r.stderr);
  ok('contacts --exchange：寫進雙機的通訊錄',
    existsSync(join(duoDir, '通訊錄.md')) && readFileSync(join(duoDir, '通訊錄.md'), 'utf8').includes('owner@example.com'));
  ok('contacts --exchange：預設交換區的通訊錄沒被動', !existsSync(join(userDir, '通訊錄.md')));
  r = run('contacts.mjs', ['check', 'Mac', '--exchange', '雙機']);
  ok('contacts --exchange：在雙機查得到 Mac', r.status === 0 && JSON.parse(r.stdout).active === true, r.stdout + r.stderr);
  r = run('contacts.mjs', ['check', 'Mac']);
  ok('contacts：不帶 --exchange 查的是預設交換區，找不到 Mac', r.status === 0 && JSON.parse(r.stdout).found === false, r.stdout);
  r = run('contacts.mjs', ['list', '--exchange', '不存在']);
  ok('contacts --exchange：找不到交換區 exit 1', r.status === 1);
}

// ── 10. 閘門：額外交換區的訊息用那一區的通訊錄 ─────────────────
{
  const duoMsg = join(duoEx, '收件匣-Windows', DUO_MSG);
  writeFileSync(duoMsg, '---\nfrom: Mac\nto: Windows\n---\n正文\n');
  let r = run('gate.mjs', [duoMsg, '--owner', 'owner@example.com']);
  let v = JSON.parse(r.stdout);
  ok('閘門：雙機的訊息查雙機的通訊錄 → pass', v.pass === true, JSON.stringify(v.anomaly));
  ok('閘門：判定結果標了交換區', v.exchangeId === '雙機');

  const teamMsg = join(teamEx, '收件匣-Alice', '訊息_Mac→Alice_跑錯區_2026-09-05.md');
  writeFileSync(teamMsg, '---\nfrom: Mac\nto: Alice\n---\n正文\n');
  r = run('gate.mjs', [teamMsg, '--owner', 'owner@example.com']);
  v = JSON.parse(r.stdout);
  ok('閘門：同一個 owner 寄到團隊交換區，查的是團隊的通訊錄 → 不過', v.pass === false && v.exchangeId === null, JSON.stringify(v));
}

// ── 11. 注入器：開場與搭便車 ───────────────────────────────────
const injEnv = { ...process.env, CLAUDE_PLUGIN_ROOT: join(SCRIPTS, '..') };
const inject = (event, sessionId) => {
  rmSync(join(dataDir, 'locks'), { recursive: true, force: true }); // 5 秒去重鎖會擋連續呼叫
  const r = spawnSync(process.execPath, [join(SCRIPTS, 'inject.mjs'), '--event', event],
    { input: JSON.stringify({ session_id: sessionId, tool_name: 'Bash' }), env: injEnv, encoding: 'utf8' });
  const out = (r.stdout ?? '').trim();
  return out ? JSON.parse(out).hookSpecificOutput.additionalContext : null;
};
const sessionFile = join(dataDir, 'sessions', 'ex-test.json');
const backdate = () => { // 跳過 10 秒節流
  const s = JSON.parse(readFileSync(sessionFile, 'utf8'));
  s.lastScanAt -= 60_000;
  writeFileSync(sessionFile, JSON.stringify(s));
};
{
  // 前面的步驟已經把雙機的兩封記成已讀，開場前先讓雙機再落地一封，基準裡才有雙機的東西可以檢查
  const OPENING = '訊息_Mac→Windows_開場前新到_2026-09-07.md';
  writeFileSync(join(duoEx, '收件匣-Windows', OPENING), 'x');
  const ctx = inject('SessionStart', 'ex-test') ?? '';
  ok('注入：開場講到雙機', /交換區「雙機」（代稱 Windows）有 1 筆/.test(ctx), ctx);
  ok('注入：雙機那封列出時標了交換區', /【雙機】訊息：Mac → 開場前新到/.test(ctx), ctx);
  ok('注入：記帳指示提到 --exchange', /--exchange/.test(ctx), ctx);
  const st = JSON.parse(readFileSync(sessionFile, 'utf8'));
  ok('注入：狀態記下兩個交換區都建過基準', st.exchanges.includes('') && st.exchanges.includes('雙機'), JSON.stringify(st.exchanges));
  ok('注入：基準用帶交換區前綴的 key', st.announced.includes(`雙機/${OPENING}`), JSON.stringify(st.announced));
  ok('注入：預設交換區的基準仍是純檔名', st.announced.includes(SAME));
  ok('注入：雙機的已讀彙總檔寫在雙機的收件匣', existsSync(join(duoEx, '收件匣-Windows', '已讀-Windows.md')));
  ok('注入：團隊的已讀彙總檔寫在團隊的收件匣', existsSync(join(teamEx, '收件匣-Alice', '已讀-Alice.md')));

  // 對話開著時才加掛的交換區。裡面三種檔：
  //   已經在那一區已讀帳裡的＝歷史，不報
  //   收件匣交給其他系統追蹤、不追蹤的舊檔＝只建基準，不報
  //   雷達自己追、不在已讀帳的＝還沒處理的信，第一次搭便車就要報（0.7.0 把它一起吞掉了）
  const lateEx = join(root, 'drive', '_交換區-後掛');
  mkdirSync(join(lateEx, '收件匣-Late'), { recursive: true });
  mkdirSync(join(lateEx, '公告板'), { recursive: true });
  writeFileSync(join(lateEx, '公告板', '公告_後掛歷史_2026-09-04.md'), 'x');
  writeFileSync(join(lateEx, '公告板', '公告_後掛未讀_2026-09-05.md'), 'x');
  writeFileSync(join(lateEx, '收件匣-Late', '訊息_甲→Late_別的系統在追_2026-09-05.md'), 'x');
  const lateDir = join(userDir, '交換區', '後掛');
  mkdirSync(lateDir, { recursive: true });
  writeFileSync(join(lateDir, 'config.md'), `名字：Late\n交換區：${lateEx}\n收件匣追蹤：其他系統\n`);
  writeFileSync(join(lateDir, 'read.md'), '- 公告_後掛歷史_2026-09-04.md（已讀）\n');

  backdate();
  const first = inject('PostToolUse', 'ex-test') ?? '';
  ok('後掛：第一次搭便車就報還沒處理的信', first.includes('公告_後掛未讀_2026-09-05.md'), first);
  ok('後掛：列出時標了交換區', /【後掛】/.test(first), first);
  ok('後掛：已讀帳裡的歷史不報', !first.includes('公告_後掛歷史_2026-09-04.md'), first);
  ok('後掛：別的系統在追的收件匣舊檔不報', !first.includes('別的系統在追'), first);
  ok('後掛：狀態記上後掛交換區', JSON.parse(readFileSync(sessionFile, 'utf8')).exchanges.includes('後掛'));

  backdate();
  ok('後掛：報過的不重複報', inject('PostToolUse', 'ex-test') === null);

  writeFileSync(join(lateEx, '公告板', '公告_後掛新到_2026-09-06.md'), 'x');
  writeFileSync(join(lateEx, '收件匣-Late', '訊息_乙→Late_剛落地_2026-09-06.md'), 'x');
  backdate();
  const c = inject('PostToolUse', 'ex-test') ?? '';
  ok('後掛：之後公告板新到的照樣報', c.includes('公告_後掛新到_2026-09-06.md'), c);
  ok('後掛：之後收件匣剛落地的也報（即時通知）', c.includes('剛落地'), c);
  ok('後掛：先前建過基準的收件匣舊檔沒有一起報', !c.includes('別的系統在追'), c);

  // watcher 用的新落地判定（純函式）
  {
    const { pickFresh } = await import(pathToFileURL(join(SCRIPTS, 'state.mjs')).href);
    const mk = (key, exchangeId, tracked = true) => ({ key, file: key, exchangeId, tracked });
    const seen = new Set();
    const baselined = new Set();
    const round1 = pickFresh([mk('a.md', null), mk('雙機/b.md', '雙機')], { seen, baselined, first: true });
    ok('watcher：第一輪只建基準', round1.length === 0 && seen.size === 2);
    baselined.add('');
    const round2 = pickFresh([mk('a.md', null), mk('新/未讀.md', '新'), mk('新/外部追.md', '新', false)], { seen, baselined, first: false });
    ok('watcher：新掛交換區裡雷達自己追的信要通知', round2.map((u) => u.key).join() === '新/未讀.md', JSON.stringify(round2));
    ok('watcher：新掛交換區裡不追蹤的舊檔只建基準', seen.has('新/外部追.md'));
    baselined.add('新');
    const round3 = pickFresh([mk('新/未讀.md', '新'), mk('新/外部追.md', '新', false), mk('新/外部追2.md', '新', false)], { seen, baselined, first: false });
    ok('watcher：建過基準的交換區，不追蹤的新檔照樣通知', round3.map((u) => u.key).join() === '新/外部追2.md', JSON.stringify(round3));
  }

  // 額外交換區讀不到時，開場要講
  const badDir = join(userDir, '交換區', '讀不到');
  mkdirSync(badDir, { recursive: true });
  writeFileSync(join(badDir, 'config.md'), '名字：Y\n');
  const ctx2 = inject('SessionStart', 'ex-test-2') ?? '';
  ok('注入：額外交換區讀不到時開場有警告', /交換區「讀不到」/.test(ctx2) && /偵測不到/.test(ctx2), ctx2);
}

// ── 結果 ─────────────────────────────────────────────────────────
// 注入器會帶起桌鈴（全機單例、detached）。Windows 上它一啟動就退出；其他平臺會一直活著、
// 指向這個已刪掉的暫存目錄，所以這裡順手收掉。
try { process.kill(Number(readFileSync(join(dataDir, 'deskbell.pid'), 'utf8').trim())); } catch {}
for (const name of pass) console.log(`  ok  ${name}`);
console.log(`\n${pass.length} passed, ${fail.length} failed`);
rmSync(root, { recursive: true, force: true });
process.exit(fail.length ? 1 : 0);
