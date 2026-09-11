// 收件匣「交給其他系統追蹤」模式的驗收測試（Phase 6 task 11）。跑法：
//   node tests/tracking.test.mjs
// 全部 assertion 過才 exit 0。測試資料寫在系統暫存目錄，不碰真實的 ~/.claude 與交換區。
//
// 這個模式要解的問題：使用者另有一個系統（例如每日掃描）處理收件匣，那邊處理掉的訊息
// 雷達的已讀帳永遠不會知道，開場未讀數就會一直漂高。兩個互不溝通的系統要不打架，
// 唯一的方法是不要搶同一份工作——收件匣的「要做什麼」交給那個系統，雷達對收件匣只做
// 「剛到了」的即時通知、不記舊帳。公告板沒有別人追，雷達照舊記帳。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..', 'scripts');
const root = join(tmpdir(), 'mailbox-radar-tracking-test');
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
// deskbell 在模組載入時會解析 data dir；指到暫存目錄，免得碰真實狀態
process.env.MAILBOX_RADAR_DATA = join(root, 'data');

const { detect, readConfig } = await import(pathToFileURL(join(SCRIPTS, 'detect.mjs')).href);
const { formatUnread } = await import(pathToFileURL(join(SCRIPTS, 'format.mjs')).href);
const { plan } = await import(pathToFileURL(join(SCRIPTS, 'deskbell.mjs')).href);

const pass = [];
const fail = [];
const ok = (name, cond, extra = '') => { (cond ? pass : fail).push(name); if (!cond) console.log(`FAIL  ${name}  ${extra}`); };

// 共用假交換區：收件匣 3 封（全部不在已讀帳）、公告板 2 封（1 封已讀）
const ex = join(root, '交換區');
const inbox = join(ex, '收件匣-測試員');
const board = join(ex, '公告板');
mkdirSync(inbox, { recursive: true });
mkdirSync(board, { recursive: true });
const inboxFiles = ['訊息_甲→測試員_一_2026-09-01.md', '訊息_乙→測試員_二_2026-09-02.md', '回執_一_甲_2026-09-03.md'];
const boardFiles = ['公告_規約更新_2026-09-04.md', '安裝包_某skill_2026-09-05.html'];
for (const f of inboxFiles) writeFileSync(join(inbox, f), 'x');
for (const f of boardFiles) writeFileSync(join(board, f), 'x');
const ledger = join(root, 'read.md');
writeFileSync(ledger, '- 公告_規約更新_2026-09-04.md（已讀）\n');

let cfgSeq = 0;
function cfg(extra = '') {
  const p = join(root, `config-${cfgSeq++}.md`);
  writeFileSync(p, `名字：測試員\n交換區：${ex}\n${extra}`);
  return p;
}
const EXTERNAL = '收件匣追蹤：其他系統\n';

// ── 1. 設定解析 ─────────────────────────────────────────────────
{
  ok('設定：沒寫＝雷達自己追', readConfig(cfg()).inboxTracking === 'radar');
  ok('設定：其他系統＝外部', readConfig(cfg(EXTERNAL)).inboxTracking === 'external');
  ok('設定：外部＝外部', readConfig(cfg('收件匣追蹤：外部\n')).inboxTracking === 'external');
  ok('設定：半形冒號也認', readConfig(cfg('收件匣追蹤: 其他系統\n')).inboxTracking === 'external');
  ok('設定：寫雷達＝雷達', readConfig(cfg('收件匣追蹤：雷達\n')).inboxTracking === 'radar');
  ok('設定：名字與交換區照常讀到', readConfig(cfg(EXTERNAL)).name === '測試員');
}

// ── 2. 預設模式：行為與改動前完全一樣 ─────────────────────────
{
  const r = detect({ configPath: cfg(), ledgerPath: ledger });
  ok('預設：偵測成功', r.ok, r.error ?? '');
  ok('預設：未讀＝收件匣 3＋公告板 1＝4', r.unreadCount === 4, `實際 ${r.unreadCount}`);
  ok('預設：arrivals 與 unread 是同一批、同順序',
    r.arrivals.length === r.unread.length && r.arrivals.every((u, i) => u.file === r.unread[i].file));
  ok('預設：沒有不追蹤的', r.untrackedCount === 0 && r.arrivals.every((u) => u.tracked === true));
  ok('預設：unreadCount 與清單長度一致', r.unread.length === r.unreadCount);
  ok('預設：結果帶模式標記', r.inboxTracking === 'radar');
}

// ── 3. 外部模式：收件匣不進未讀數，但仍出現在 arrivals ─────────
{
  const r = detect({ configPath: cfg(EXTERNAL), ledgerPath: ledger });
  ok('外部：未讀只剩公告板那 1 封',
    r.unreadCount === 1 && r.unread[0]?.file === '安裝包_某skill_2026-09-05.html', `實際 ${r.unreadCount}`);
  ok('外部：unread 裡沒有任何收件匣的檔', r.unread.every((u) => u.channel !== 'inbox'));
  ok('外部：arrivals 仍含收件匣 3 封＋公告板 1 封', r.arrivals.length === 4, `實際 ${r.arrivals.length}`);
  ok('外部：收件匣的都標成不追蹤', r.arrivals.filter((u) => u.channel === 'inbox').every((u) => u.tracked === false));
  ok('外部：公告板的仍標成追蹤', r.arrivals.filter((u) => u.channel === 'board').every((u) => u.tracked === true));
  ok('外部：untrackedCount＝3', r.untrackedCount === 3);
  ok('外部：結果帶模式標記', r.inboxTracking === 'external');
  ok('外部：unreadCount 與清單長度一致', r.unread.length === r.unreadCount);
  ok('外部：掃描帳照樣記收件匣總數', r.scanned.inbox.total === 3);
}

// ── 4. 開場報告的文字 ───────────────────────────────────────────
{
  const r = detect({ configPath: cfg(EXTERNAL), ledgerPath: ledger });
  const text = formatUnread(r, { mode: 'session', limit: 8 }) ?? '';
  ok('開場：講清楚收件匣交給其他系統', /收件匣交給其他系統/.test(text), text);
  ok('開場：沒有列出任何收件匣的檔', inboxFiles.every((f) => !text.includes(f)));
  ok('開場：公告板那封有列', text.includes('安裝包_某skill_2026-09-05.html'));
  ok('開場：不會寫出容易誤會的「收件匣 0」', !/收件匣 0/.test(text));

  // 公告板也全讀了、收件匣仍有檔 → 開場整段不出現
  const allRead = join(root, 'read-all.md');
  writeFileSync(allRead, boardFiles.map((f) => `- ${f}`).join('\n') + '\n');
  const r2 = detect({ configPath: cfg(EXTERNAL), ledgerPath: allRead });
  ok('開場：公告板全讀、收件匣有舊檔 → 不輸出任何東西',
    formatUnread(r2, { mode: 'session' }) === null, `unreadCount=${r2.unreadCount}`);

  // 預設模式的開場文字不變
  const r3 = detect({ configPath: cfg(), ledgerPath: ledger });
  const t3 = formatUnread(r3, { mode: 'session', limit: 8 }) ?? '';
  ok('開場：預設模式仍是「收件匣 N、公告板 N」', /收件匣 3、公告板 1/.test(t3), t3);
}

// ── 5. 工作途中的即時通知：收件匣新落地照樣報，舊的不當新的 ────
{
  const r = detect({ configPath: cfg(EXTERNAL), ledgerPath: ledger });
  const announced = new Set(r.arrivals.map((u) => u.file)); // 開場那一刻建的基準（inject 用 arrivals）
  ok('即時：開場基準含收件匣舊檔', inboxFiles.every((f) => announced.has(f)));

  writeFileSync(join(inbox, '訊息_丙→測試員_新的_2026-09-10.md'), 'x');
  const r2 = detect({ configPath: cfg(EXTERNAL), ledgerPath: ledger });
  const fresh = r2.arrivals.filter((u) => !announced.has(u.file));
  ok('即時：新落地的收件匣訊息被偵測到', fresh.length === 1 && fresh[0].file === '訊息_丙→測試員_新的_2026-09-10.md');
  ok('即時：舊的收件匣訊息沒有被當成新落地', !fresh.some((u) => inboxFiles.includes(u.file)));
  const text = formatUnread({ ...r2, unread: fresh, unreadCount: fresh.length }, { mode: 'inline' }) ?? '';
  ok('即時：搭便車通知有列出它', text.includes('訊息_丙→測試員_新的_2026-09-10.md'));

  // 反例：如果基準錯用 unread，舊檔會被誤判成新落地——這正是改用 arrivals 的理由
  const wrongBase = new Set(r.unread.map((u) => u.file));
  const wrongFresh = r2.arrivals.filter((u) => !wrongBase.has(u.file));
  ok('即時（反例）：基準用 unread 會把收件匣歷史誤報成新落地', wrongFresh.length === 4, `實際 ${wrongFresh.length}`);
}

// ── 6. 桌鈴：預設模式行為不變 ───────────────────────────────────
{
  const items = [{ file: 'a.md', tracked: true }, { file: 'b.md', tracked: true }];
  let p = plan(items, { notified: {} }, 1000, { repeatMs: 100 });
  ok('桌鈴預設：第一輪全部響', p.ring.length === 2 && p.fresh === 2 && p.freshUntracked === 0);
  p = plan(items, p.state, 1050, { repeatMs: 100 });
  ok('桌鈴預設：未到重響時間不響', p.ring.length === 0);
  p = plan(items, p.state, 1200, { repeatMs: 100 });
  ok('桌鈴預設：到時間重響', p.ring.length === 2 && p.due === 2);
  p = plan([items[0]], p.state, 1250, { repeatMs: 100 });
  ok('桌鈴預設：已讀掉的忘記', !('b.md' in p.state.notified));

  const legacy = plan([{ file: 'x.md' }], { notified: {} }, 0, { repeatMs: 100 });
  ok('桌鈴預設：沒帶 tracked 欄位的舊呼叫端當成追蹤', legacy.ring.length === 1);
  const legacyDue = plan([{ file: 'x.md' }], legacy.state, 200, { repeatMs: 100 });
  ok('桌鈴預設：沒帶 tracked 欄位的照樣重響', legacyDue.due === 1);
}

// ── 7. 桌鈴：外部模式 ───────────────────────────────────────────
{
  const backlog = [
    { file: 'inbox-old-1.md', tracked: false },
    { file: 'inbox-old-2.md', tracked: false },
    { file: 'board-1.md', tracked: true },
  ];
  let p = plan(backlog, { notified: {} }, 1000, { repeatMs: 100 });
  ok('桌鈴外部：第一輪不為收件匣歷史響（只建基準）',
    p.ring.length === 1 && p.ring.every((u) => u.tracked), JSON.stringify(p.ring));
  ok('桌鈴外部：公告板的第一輪照樣響', p.ring[0]?.file === 'board-1.md');
  ok('桌鈴外部：第一輪之後標記已建基準', p.state.seeded === true);

  const withNew = [...backlog, { file: 'inbox-new.md', tracked: false }];
  p = plan(withNew, p.state, 1050, { repeatMs: 100 });
  ok('桌鈴外部：收件匣新落地響一次',
    p.ring.length === 1 && p.ring[0].file === 'inbox-new.md' && p.freshUntracked === 1);

  p = plan(withNew, p.state, 1300, { repeatMs: 100 });
  ok('桌鈴外部：過了重響時間，收件匣的不重響', p.ring.every((u) => u.tracked));
  ok('桌鈴外部：過了重響時間，公告板的照樣重響', p.ring.some((u) => u.file === 'board-1.md') && p.due === 1);

  // 已經建過基準之後才出現的檔（例如雲端同步延遲），一律當新到響一次
  p = plan([...withNew, { file: 'inbox-late.md', tracked: false }], p.state, 1350, { repeatMs: 100 });
  ok('桌鈴外部：建過基準之後出現的都算新到', p.ring.some((u) => u.file === 'inbox-late.md'));

  // 狀態檔遺失（例如資料目錄被清掉）→ 重新建基準，不會整批倒出來
  const again = plan(withNew, { notified: {} }, 2000, { repeatMs: 100 });
  ok('桌鈴外部：狀態遺失後重新建基準，收件匣不整批響', again.ring.every((u) => u.tracked));
}

// ── 結果 ─────────────────────────────────────────────────────────
for (const name of pass) console.log(`  ok  ${name}`);
console.log(`\n${pass.length} passed, ${fail.length} failed`);
rmSync(root, { recursive: true, force: true });
process.exit(fail.length ? 1 : 0);
