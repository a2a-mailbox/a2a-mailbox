// 通訊錄的驗收測試（Phase 6 task 3）。跑法：
//   node tests/contacts.test.mjs
// 全部 assertion 過才 exit 0。測試資料寫在系統暫存目錄，**不碰真實的 ~/.claude**。
// 所有人名、email 都是虛構的（example.com）。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..', 'scripts');
const root = join(tmpdir(), 'mailbox-radar-contacts-test');
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

// 環境變數要在 import 之前設好：gate.mjs 在模組載入時就讀一次名單
const userDir = join(root, 'team-mailbox');
mkdirSync(userDir, { recursive: true });
const CONTACTS = join(userDir, '通訊錄.md');
const CONFIG = join(userDir, 'config.md');
process.env.TEAM_MAILBOX_USER_DATA = userDir;
process.env.TEAM_MAILBOX_LEGACY_DIR = join(root, 'legacy-none');
process.env.MAILBOX_RADAR_CONTACTS = CONTACTS;
process.env.MAILBOX_RADAR_CONFIG = CONFIG;
writeFileSync(CONFIG, `名字：Alice\n交換區：${join(root, 'fake-ex')}\n`);

const C = await import(pathToFileURL(join(SCRIPTS, 'contacts.mjs')).href);

const pass = [];
const fail = [];
const ok = (name, cond, extra = '') => { (cond ? pass : fail).push(name); if (!cond) console.log(`FAIL  ${name}  ${extra}`); };

// ── 1. 解析與序列化 ─────────────────────────────────────────────
{
  const raw = [
    '# 通訊錄', '', '> 註解行要被忽略', '',
    '| email | 代稱 | 姓名 | 來源 | 狀態 |',
    '|---|---|---|---|---|',
    '| Alice@Example.com | Alice、小A | 王小艾 | drive | active |',
    '｜bob@example.com｜Bob｜｜manual｜left｜',            // 全形分隔符、姓名空白
    '| carol@example.com | Carol | 陳卡蘿 | 打錯 | 打錯 |',   // 不合法的來源／狀態
    '| alice@example.com | 重複 | 重複 | drive | left |',      // 重複 email 取第一列
    '',
  ].join('\n');
  const list = C.parseContacts('﻿' + raw.replace(/\n/g, '\r\n'));
  ok('解析：三個人（重複 email 只算一次）', list.length === 3, `實際 ${list.length}`);
  const a = list.find((c) => c.email === 'alice@example.com');
  ok('解析：email 正規化成小寫', !!a);
  ok('解析：代稱拆成陣列', a && a.aliases.length === 2 && a.aliases[0] === 'Alice' && a.aliases[1] === '小A');
  ok('解析：姓名、來源、狀態', a && a.name === '王小艾' && a.source === 'drive' && a.status === 'active');
  ok('解析：重複列取第一列', a && a.status === 'active');
  const b = list.find((c) => c.email === 'bob@example.com');
  ok('解析：全形分隔符也認', b && b.aliases[0] === 'Bob' && b.status === 'left');
  ok('解析：姓名可以空白', b && b.name === '');
  const c = list.find((c) => c.email === 'carol@example.com');
  ok('解析：不合法的來源退成 manual、狀態退成 active（寧可多認不要靜默踢人）', c && c.source === 'manual' && c.status === 'active');

  const again = C.parseContacts(C.serializeContacts(list));
  ok('序列化再解析：往返一致', JSON.stringify(again) === JSON.stringify(list));
  ok('序列化：帶最後同步註記', C.serializeContacts(list, { syncedAt: '2026-01-01 00:00' }).includes('最後同步：2026-01-01 00:00'));
}

// ── 2. 查詢與寄信前檢查 ─────────────────────────────────────────
{
  const list = C.parseContacts([
    '| alice@example.com | Alice、小A | 王小艾 | drive | active |',
    '| bob@example.com | Bob | 李小波 | drive | left |',
  ].join('\n'));
  ok('findContact：用代稱找', C.findContact(list, '小A')?.email === 'alice@example.com');
  ok('findContact：用姓名找', C.findContact(list, '王小艾')?.email === 'alice@example.com');
  ok('findContact：用 email 找（大小寫不拘）', C.findContact(list, 'ALICE@example.com')?.email === 'alice@example.com');
  ok('findContact：找不到回 null', C.findContact(list, '路人') === null);
  ok('checkRecipient：active 的人可寄', C.checkRecipient(list, 'Alice').active === true && C.checkRecipient(list, 'Alice').note === null);
  const left = C.checkRecipient(list, 'Bob');
  ok('checkRecipient：left 的人擋下並給說明', left.found && !left.active && /已離開/.test(left.note));
  const none = C.checkRecipient(list, '路人');
  ok('checkRecipient：不在名單給說明', !none.found && /不在通訊錄/.test(none.note));
}

// ── 3. 人工加人／移除 ───────────────────────────────────────────
{
  let list = [];
  let r = C.addContact(list, { email: 'Dave@Example.com', alias: 'Dave', name: '張大衛' });
  list = r.list;
  ok('add：新增一列、來源 manual', r.action === 'added' && list[0].email === 'dave@example.com' && list[0].source === 'manual');
  r = C.addContact(list, { email: 'dave@example.com', alias: '小D', name: '別的名字' });
  ok('add：既有的人只補代稱、不覆寫姓名', r.action === 'updated' && r.entry.aliases.join('、') === 'Dave、小D' && r.entry.name === '張大衛');
  r = C.removeContact(list, '小D');
  ok('remove：標 left、不刪列', r.entry?.status === 'left' && list.length === 1);
  r = C.addContact(list, { email: 'dave@example.com', alias: 'Dave' });
  ok('add：left 的人重新加入＝reactivated', r.action === 'reactivated' && r.entry.status === 'active');
  ok('remove：找不到回 entry null', C.removeContact(list, '路人').entry === null);
  let threw = false;
  try { C.addContact(list, { email: '不是email', alias: 'x' }); } catch { threw = true; }
  ok('add：email 格式不對要丟錯', threw);
}

// ── 4. Drive 同步合併規則（六條）─────────────────────────────────
{
  const before = C.parseContacts([
    '| alice@example.com | Alice | 王小艾 | drive | active |',   // 自己
    '| bob@example.com | Bob | 李小波 | drive | active |',       // 這次不在 members → left
    '| carol@example.com | Carol | 人工填的名 | manual | active |', // manual、不在 members → 不動但提醒
    '| erin@example.com | Erin | | drive | left |',              // 這次回來了 → active
  ].join('\n'));
  const facts = {
    members: [
      { email: 'alice@example.com', role: 'owner' },
      { email: 'Erin@example.com', role: 'writer' },
      { email: 'frank@example.com', role: 'writer' },   // 新人
      { email: 'gina@example.com', role: 'reader' },    // 新人，代稱對不上
    ],
    names: { 'alice@example.com': '王小艾', 'erin@example.com': '林艾琳', 'frank@example.com': '法蘭克', 'carol@example.com': 'Drive 的名' },
    folderAliases: ['Alice', 'Erin', '法蘭克', 'Gina', 'Hank'],
  };
  const { list, report } = C.mergeFromDrive(before, facts);
  const by = (e) => list.find((c) => c.email === e);

  ok('規則1：drive 來源、不在 members → left', by('bob@example.com').status === 'left' && report.left.includes('bob@example.com'));
  ok('規則2：manual 來源、不在 members → 不動、列入提醒', by('carol@example.com').status === 'active' && report.manualNotInDrive.includes('carol@example.com'));
  ok('規則3：新 email 新列、來源 drive', by('frank@example.com')?.source === 'drive' && report.added.includes('frank@example.com'));
  ok('規則3：left 的人回來 → active', by('erin@example.com').status === 'active' && report.reactivated.includes('erin@example.com'));
  ok('規則4：原本空白的姓名補上', by('erin@example.com').name === '林艾琳');
  ok('規則4：manual 來源已有姓名不覆寫', by('carol@example.com').name === '人工填的名');
  ok('規則5a：代稱＝既有代稱 → 對上', by('alice@example.com').aliases.includes('Alice'));
  ok('規則5b：代稱＝顯示名 → 對上並加進代稱', by('frank@example.com').aliases.includes('法蘭克'));
  ok('規則5：對不上的代稱留在 unmappedAliases、不猜', report.unmappedAliases.includes('Gina') && report.unmappedAliases.includes('Hank') && !by('gina@example.com').aliases.length);
  ok('規則5：沒代稱的 active email 列在 unmappedEmails', report.unmappedEmails.includes('gina@example.com'));
  ok('規則6：純函式不改輸入', before.find((c) => c.email === 'bob@example.com').status === 'active');

  // 第二輪：使用者確認過的 aliasMap 補上對應
  const r2 = C.mergeFromDrive(list, { ...facts, aliasMap: { Gina: 'gina@example.com' } });
  ok('aliasMap：使用者確認的對應加進代稱', r2.list.find((c) => c.email === 'gina@example.com').aliases.includes('Gina'));
  ok('aliasMap：Hank 仍然對不上（沒有他的 email）', r2.report.unmappedAliases.join() === 'Hank');
  ok('冪等：第二輪不再回報 added／left', r2.report.added.length === 0 && r2.report.left.length === 0);
}

// ── 4b. 防呆：分享名單只回擁有者一筆時，不把其他人標成離開 ─────
// 實測過有 Drive 連接器查 permissions 只給擁有者一筆。照規則 1 硬套會把同事全標成 left，
// 閘門接著把他們的訊息都判成異常，而且當下不會有任何跡象。
{
  const before = C.parseContacts([
    '| alice@example.com | Alice | 王小艾 | drive | active |',
    '| bob@example.com | Bob | 李小波 | drive | active |',
    '| carol@example.com | Carol | 陳卡蘿 | drive | active |',
  ].join('\n'));

  const ownerOnly = C.mergeFromDrive(before, { members: [{ email: 'alice@example.com', role: 'owner' }] });
  ok('防呆：只回擁有者一筆 → 沒有人被標成離開',
    ownerOnly.report.left.length === 0 && ownerOnly.list.every((c) => c.status === 'active'));
  ok('防呆：只回擁有者一筆 → warnings 講清楚原因',
    ownerOnly.report.warnings.length === 1 && /只回擁有者/.test(ownerOnly.report.warnings[0]), JSON.stringify(ownerOnly.report.warnings));

  const empty = C.mergeFromDrive(before, { members: [] });
  ok('防呆：分享名單是空的 → 沒有人被標成離開',
    empty.report.left.length === 0 && empty.list.every((c) => c.status === 'active'));

  const legit = C.mergeFromDrive(before, { members: [{ email: 'alice@example.com' }, { email: 'bob@example.com' }] });
  ok('防呆：名單有兩筆以上照常運作 → 不在名單的 drive 成員標成離開',
    legit.report.left.join() === 'carol@example.com' && legit.report.warnings.length === 0);

  const noOtherDrive = C.mergeFromDrive(
    C.parseContacts('| alice@example.com | Alice | | drive | active |\n| bob@example.com | Bob | | manual | active |'),
    { members: [{ email: 'alice@example.com' }] });
  ok('防呆：沒有其他 drive 成員會被影響時不發警告', noOtherDrive.report.warnings.length === 0);
  ok('防呆：一般情況 report 也帶 warnings 欄位', Array.isArray(legit.report.warnings));
}

// ── 5. 健檢：自己那列一定要有姓名 ─────────────────────────────
{
  const full = C.parseContacts('| alice@example.com | Alice | 王小艾 | drive | active |');
  const empty = C.parseContacts('| alice@example.com | Alice | | drive | active |');
  ok('健檢：自己有姓名 → null', C.healthCheck(full, 'Alice') === null);
  ok('健檢：自己沒姓名 → 警告指向查詢問題', /綁錯|重查/.test(C.healthCheck(empty, 'Alice') ?? ''));
  ok('健檢：找不到自己 → 警告', /找不到你自己/.test(C.healthCheck(full, 'Nobody') ?? ''));
  // null 只能有一個意思（檢查過且健康）。沒 selfName 時曾回 null，會被讀成「健康」——設計缺陷，
  // 2026-09-08 改掉；當時驗證以為實際踩到，後查明是誤判，但規則本身不變。
  ok('健檢：沒給自己的名字 → 回「沒有跑」的明確字串，不是 null', typeof C.healthCheck(empty, null) === 'string' && /健檢沒有跑/.test(C.healthCheck(empty, null)));
  ok('健檢：沒給自己的名字時，就算名單健康也不回 null', C.healthCheck(full, '') !== null);
}

// ── 6. config.md 白名單 → 通訊錄（升級轉入）────────────────────
{
  const dir = join(root, 'migrate');
  mkdirSync(dir, { recursive: true });
  const cfg = join(dir, 'config.md');
  const ct = join(dir, '通訊錄.md');
  writeFileSync(cfg, '名字：Alice\n交換區：/x\n白名單：alice@example.com Alice 王小艾\n白名單：bob@example.com Bob\n');
  const r = C.migrateWhitelist({ contactsPath: ct, configPath: cfg });
  ok('轉入：兩人寫進通訊錄', r.migrated === 2 && existsSync(ct));
  const list = C.loadContacts(ct);
  ok('轉入：舊格式「代稱 姓名」全收成代稱、來源 manual', list[0].aliases.join('、') === 'Alice、王小艾' && list[0].source === 'manual');
  const r2 = C.migrateWhitelist({ contactsPath: ct, configPath: cfg });
  ok('轉入：冪等（通訊錄已存在就不動）', r2.migrated === 0);
  ok('轉入：config.md 原樣不動', readFileSync(cfg, 'utf8').includes('白名單：bob@example.com Bob'));
  const r3 = C.migrateWhitelist({ contactsPath: join(dir, 'none.md'), configPath: join(dir, 'no-config.md') });
  ok('轉入：沒有白名單行就不建檔', r3.migrated === 0 && !existsSync(join(dir, 'none.md')));
}

// ── 7. 閘門整合：gate.mjs 改讀通訊錄 ────────────────────────────
{
  writeFileSync(CONTACTS, C.serializeContacts(C.parseContacts([
    '| alice@example.com | Alice | 王小艾 | drive | active |',
    '| bob@example.com | Bob | 李小波 | drive | left |',
  ].join('\n'))));
  const G = await import(pathToFileURL(join(SCRIPTS, 'gate.mjs')).href);
  const msgDir = join(root, 'msgs');
  mkdirSync(msgDir, { recursive: true });
  const write = (name, from) => { const p = join(msgDir, name); writeFileSync(p, `---\nfrom: ${from}\nto: Carol\n---\n正文\n`); return p; };

  const p1 = write('訊息_Alice→Carol_主題_2026-09-08.md', 'Alice');
  const v1 = G.verdict(p1, 'alice@example.com');
  ok('閘門：active 成員、owner 與宣稱一致 → pass', v1.pass === true, JSON.stringify(v1.anomaly));
  ok('閘門：ownerName 帶代稱與姓名', /Alice/.test(v1.ownerName) && /王小艾/.test(v1.ownerName));

  const p2 = write('訊息_Bob→Carol_主題_2026-09-08.md', 'Bob');
  const v2 = G.verdict(p2, 'bob@example.com');
  ok('閘門：left 成員 → 不過、異常說已離開', v2.pass === false && v2.anomaly.some((a) => /已離開/.test(a)));

  const v3 = G.verdict(p1, 'bob@example.com');
  ok('閘門：宣稱 Alice 但 owner 是 Bob → 冒寫異常', v3.pass === false && v3.anomaly.some((a) => /冒寫/.test(a)));

  // 同一個人兩個 Google 帳號：通訊錄兩列、同一個代稱，兩個帳號寫的信都要過；別人用這個代稱仍然是冒寫
  const twoAccounts = [
    { email: 'dana@company.example', aliases: ['Dana'], name: '', source: 'manual', status: 'active' },
    { email: 'dana.private@example.com', aliases: ['Dana'], name: '', source: 'manual', status: 'active' },
    { email: 'eve@example.com', aliases: ['Eve'], name: '', source: 'manual', status: 'active' },
  ];
  const pd = write('訊息_Dana→Carol_主題_2026-09-18.md', 'Dana');
  ok('閘門：同代稱第一個帳號 → pass', G.verdict(pd, 'dana@company.example', twoAccounts).pass === true);
  ok('閘門：同代稱第二個帳號 → pass', G.verdict(pd, 'dana.private@example.com', twoAccounts).pass === true,
    JSON.stringify(G.verdict(pd, 'dana.private@example.com', twoAccounts).anomaly));
  ok('閘門：別人宣稱同一個代稱 → 仍是冒寫', G.verdict(pd, 'eve@example.com', twoAccounts).anomaly.some((a) => /冒寫/.test(a)));

  const v4 = G.verdict(p1, 'stranger@example.com');
  ok('閘門：不在通訊錄 → 異常', v4.pass === false && v4.anomaly.some((a) => /不在通訊錄/.test(a)));

  ok('閘門：emailForName 用姓名也查得到', G.emailForName('王小艾') === 'alice@example.com');
  ok('閘門：舊形狀 WHITELIST 只含 active', Object.keys(G.WHITELIST).join() === 'alice@example.com');

  // 空名單：傳入空 roster
  const v5 = G.verdict(p1, 'alice@example.com', []);
  ok('閘門：通訊錄空 → 異常指向「同步通訊錄」', v5.pass === false && v5.anomaly.some((a) => /同步通訊錄/.test(a)));

  // 通訊錄不存在但 config 有白名單行 → 退回讀白名單
  const cfg2 = join(root, 'cfg-legacy.md');
  writeFileSync(cfg2, '名字：Alice\n交換區：/x\n白名單：zed@example.com Zed\n');
  process.env.MAILBOX_RADAR_CONFIG = cfg2;
  const roster = G.loadRoster(join(root, '不存在的通訊錄.md'));
  ok('閘門：通訊錄不存在時退回 config 白名單', roster.length === 1 && roster[0].email === 'zed@example.com' && roster[0].aliases[0] === 'Zed');
  process.env.MAILBOX_RADAR_CONFIG = CONFIG;
}

// ── 7b. 固定先問人（0.9.0）──────────────────────────────────────
// 被標記的人照樣算名單內、不標異常，但授權下限鎖在 2。用途是會主動寄「請你簽核」的自動化帳號。
{
  // 解析：第六欄
  const six = C.parseContacts([
    '| email | 代稱 | 姓名 | 來源 | 狀態 | 先問人 |',
    '|---|---|---|---|---|---|',
    '| bot@example.com | 總管 | | manual | active | 是 |',
    '| alice@example.com | Alice | 王小艾 | drive | active | |',
    '| bob@example.com | Bob | | drive | active | 否 |',
    '| carol@example.com | Carol | | drive | active | 先問 |',   // 有寫字但不是標準值
    '| dave@example.com | Dave | | drive | active | - |',
  ].join('\n'));
  const by6 = (e) => six.find((c) => c.email === e);
  ok('先問人：第六欄「是」→ true', by6('bot@example.com').askFirst === true);
  ok('先問人：第六欄空白 → false', by6('alice@example.com').askFirst === false);
  ok('先問人：第六欄「否」或「-」→ false', by6('bob@example.com').askFirst === false && by6('dave@example.com').askFirst === false);
  ok('先問人：有寫字但認不出來 → 往保守退、當成 true', by6('carol@example.com').askFirst === true);

  const five = C.parseContacts('| alice@example.com | Alice | 王小艾 | drive | active |\n｜bob@example.com｜Bob｜｜manual｜active｜');
  ok('先問人：0.8.x 的五欄檔照樣讀、全部是一般成員', five.length === 2 && five.every((c) => c.askFirst === false));

  const text = C.serializeContacts(six);
  ok('先問人：序列化表頭有第六欄', text.includes('| email | 代稱 | 姓名 | 來源 | 狀態 | 先問人 |'));
  ok('先問人：被標記的列輸出「是」、一般成員輸出空白',
    text.includes('| bot@example.com | 總管 |  | manual | active | 是 |') && text.includes('| alice@example.com | Alice | 王小艾 | drive | active |  |'));
  ok('先問人：序列化再解析往返一致', JSON.stringify(C.parseContacts(text)) === JSON.stringify(six));

  // 設定與取消
  let list = C.parseContacts([
    '| dana@company.example | Dana | 戴娜 | manual | active |',
    '| dana.private@example.com | Dana | | manual | active |',
    '| eve@example.com | Eve | | manual | active |',
  ].join('\n'));
  let r = C.setAskFirst(list, 'Eve');
  ok('setAskFirst：用代稱設上', r.entries.length === 1 && list.find((c) => c.email === 'eve@example.com').askFirst === true);
  r = C.setAskFirst(list, 'Eve', false);
  ok('setAskFirst：取消', list.find((c) => c.email === 'eve@example.com').askFirst === false);
  r = C.setAskFirst(list, 'Dana');
  ok('setAskFirst：同代稱的每一列都設上（換帳號寫信不能繞過）', r.entries.length === 2 && list.filter((c) => c.aliases.includes('Dana')).every((c) => c.askFirst === true));
  r = C.setAskFirst(list, 'dana.private@example.com', false);
  ok('setAskFirst：用 email 指定只動那一列',
    r.entries.length === 1 && list.find((c) => c.email === 'dana.private@example.com').askFirst === false && list.find((c) => c.email === 'dana@company.example').askFirst === true);
  r = C.setAskFirst(list, '戴娜', false);
  ok('setAskFirst：用姓名也找得到', r.entries.length === 1 && r.entries[0].email === 'dana@company.example');
  ok('setAskFirst：找不到人回空陣列、不丟錯', C.setAskFirst(list, '路人').entries.length === 0);

  // 加人時順便設
  r = C.addContact(list, { email: 'bot@example.com', alias: '總管', askFirst: true });
  list = r.list;
  ok('add：新增時帶 askFirst', r.action === 'added' && r.entry.askFirst === true);
  r = C.addContact(list, { email: 'bot@example.com', alias: '管家' });
  ok('add：重複 add 沒帶旗標，不會把先問人取消', r.entry.askFirst === true && r.entry.aliases.join('、') === '總管、管家');
  r = C.addContact(list, { email: 'eve@example.com', alias: 'Eve', askFirst: true });
  ok('add：既有的人帶旗標再 add → 設上', r.entry.askFirst === true);
  ok('add：沒帶旗標的新成員預設是一般成員', C.addContact([], { email: 'new@example.com', alias: 'New' }).entry.askFirst === false);

  // Drive 同步不碰這個設定
  const merged = C.mergeFromDrive(
    C.parseContacts('| alice@example.com | Alice | 王小艾 | drive | active | |\n| bot@example.com | 總管 | | manual | active | 是 |'),
    { members: [{ email: 'alice@example.com' }, { email: 'frank@example.com' }], names: {}, folderAliases: [] });
  ok('同步：既有的先問人設定原樣保留', merged.list.find((c) => c.email === 'bot@example.com').askFirst === true);
  ok('同步：一般成員仍是一般成員、新列預設一般成員',
    merged.list.find((c) => c.email === 'alice@example.com').askFirst === false && merged.list.find((c) => c.email === 'frank@example.com').askFirst === false);

  // 閘門
  const G = await import(pathToFileURL(join(SCRIPTS, 'gate.mjs')).href);
  const msgDir = join(root, 'msgs-askfirst');
  mkdirSync(msgDir, { recursive: true });
  const write = (name, from) => { const p = join(msgDir, name); writeFileSync(p, `---\nfrom: ${from}\nto: Carol\n---\n請你簽這張草稿\n`); return p; };
  const roster = C.parseContacts([
    '| bot@example.com | 總管 | | manual | active | 是 |',
    '| alice@example.com | Alice | 王小艾 | drive | active | |',
    '| oldbot@example.com | 舊總管 | | manual | left | 是 |',
    '| dana@company.example | Dana | | manual | active | 是 |',
    '| dana.private@example.com | Dana | | manual | active | 是 |',
  ].join('\n'));

  const pb = write('訊息_總管→Carol_請簽核_2026-10-02.md', '總管');
  const vb = G.verdict(pb, 'bot@example.com', roster);
  ok('閘門：先問人成員、身分一致 → 照樣 pass、沒有任何異常', vb.pass === true && vb.anomaly.length === 0, JSON.stringify(vb.anomaly));
  ok('閘門：先問人成員 → 授權下限鎖在 2、askFirst 為 true', vb.tierFloor === 2 && vb.askFirst === true);
  ok('閘門：先問人成員 → 照樣認得出是誰（不標陌生）', /總管/.test(vb.ownerName ?? ''));
  ok('閘門：先問人成員 → note 講的是固定先問人、不是異常', /固定先問人/.test(vb.note) && !/名單外／異常/.test(vb.note));

  const pa = write('訊息_Alice→Carol_主題_2026-10-02.md', 'Alice');
  const va = G.verdict(pa, 'alice@example.com', roster);
  ok('閘門：一般成員不受影響 → 下限 0、askFirst false、note null', va.pass === true && va.tierFloor === 0 && va.askFirst === false && va.note === null);

  const vSpoof = G.verdict(pb, 'alice@example.com', roster);
  ok('閘門：別人冒用先問人成員的代稱 → 仍是冒寫異常、不掛 askFirst',
    vSpoof.pass === false && vSpoof.askFirst === false && vSpoof.tierFloor === 2 && vSpoof.anomaly.some((a) => /冒寫/.test(a)) && /名單外／異常/.test(vSpoof.note));

  const po = write('訊息_舊總管→Carol_主題_2026-10-02.md', '舊總管');
  const vo = G.verdict(po, 'oldbot@example.com', roster);
  ok('閘門：先問人成員已離開 → 照已離開的異常處理', vo.pass === false && vo.askFirst === false && vo.anomaly.some((a) => /已離開/.test(a)));

  const pd2 = write('訊息_Dana→Carol_主題_2026-10-02.md', 'Dana');
  ok('閘門：同代稱兩個帳號都標了 → 第二個帳號寫的信下限也是 2',
    G.verdict(pd2, 'dana.private@example.com', roster).tierFloor === 2 && G.verdict(pd2, 'dana.private@example.com', roster).pass === true);

  const legacy = C.parseContacts('| alice@example.com | Alice | 王小艾 | drive | active |');
  ok('閘門：升級前的五欄通訊錄 → 行為跟 0.8.x 一樣（下限 0）', G.verdict(pa, 'alice@example.com', legacy).tierFloor === 0);
}

// ── 8. CLI ───────────────────────────────────────────────────────
{
  const cliContacts = join(root, 'cli', '通訊錄.md');
  const env = { ...process.env, MAILBOX_RADAR_CONTACTS: cliContacts, MAILBOX_RADAR_CONFIG: CONFIG };
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [join(SCRIPTS, 'contacts.mjs'), ...args], { encoding: 'utf8', env }));

  let r = run('add', 'alice@example.com', 'Alice', '--name', '王小艾');
  ok('CLI add：建檔並新增', r.action === 'added' && existsSync(cliContacts));
  r = run('add', 'bob@example.com', 'Bob、小B');
  ok('CLI add：第二人', r.action === 'added' && r.entry.aliases.length === 2);
  r = run('list');
  ok('CLI list：兩人', r.contacts.length === 2 && r.path === cliContacts);
  r = run('check', '小B');
  ok('CLI check：active', r.active === true);
  r = run('remove', 'Bob');
  ok('CLI remove：標 left', r.action === 'left' && r.entry.status === 'left');
  r = run('check', 'Bob');
  ok('CLI check：left 後擋下', r.active === false && /已離開/.test(r.note));

  const factsPath = join(root, 'cli', 'facts.json');
  writeFileSync(factsPath, JSON.stringify({
    members: [{ email: 'alice@example.com', role: 'owner' }, { email: 'carol@example.com', role: 'writer' }],
    names: { 'alice@example.com': '王小艾', 'carol@example.com': '陳卡蘿' },
    folderAliases: ['Alice', 'Carol'],
    aliasMap: { Carol: 'carol@example.com' },
  }));
  r = run('sync', '--facts', factsPath, '--dry-run');
  ok('CLI sync --dry-run：不寫檔', r.dryRun === true && r.path === null && run('list').contacts.length === 2);
  r = run('sync', '--facts', factsPath);
  ok('CLI sync：寫檔、加了 Carol', r.path === cliContacts && r.report.added.includes('carol@example.com'));
  ok('CLI sync：Bob 是 manual、不受 Drive 影響、列入提醒', r.report.manualNotInDrive.includes('bob@example.com'));
  ok('CLI sync：健檢用 config 的名字（Alice 有姓名）→ null 且 healthChecked true', r.health === null && r.healthChecked === true);
  ok('CLI sync：檔案帶最後同步註記', readFileSync(cliContacts, 'utf8').includes('最後同步'));

  // 沒有 config.md、facts 也沒 selfName → 健檢不能假裝健康
  const noCfgEnv = { ...env, MAILBOX_RADAR_CONFIG: join(root, 'cli', '不存在的config.md') };
  const rNo = JSON.parse(execFileSync(process.execPath, [join(SCRIPTS, 'contacts.mjs'), 'sync', '--facts', factsPath, '--dry-run'], { encoding: 'utf8', env: noCfgEnv }));
  ok('CLI sync：沒 config 也沒 selfName → healthChecked false、health 是明確字串', rNo.healthChecked === false && /健檢沒有跑/.test(rNo.health));
  writeFileSync(factsPath, JSON.stringify({ ...JSON.parse(readFileSync(factsPath, 'utf8')), selfName: 'Alice' }));
  const rSelf = JSON.parse(execFileSync(process.execPath, [join(SCRIPTS, 'contacts.mjs'), 'sync', '--facts', factsPath, '--dry-run'], { encoding: 'utf8', env: noCfgEnv }));
  ok('CLI sync：facts 帶 selfName 就不需要 config', rSelf.healthChecked === true && rSelf.health === null);

  // 固定先問人
  r = run('add', 'bot@example.com', '總管', '--ask-first');
  ok('CLI add --ask-first：新增並設上', r.action === 'added' && r.entry.askFirst === true);
  ok('CLI add --ask-first：檔案第六欄寫「是」', readFileSync(cliContacts, 'utf8').includes('| bot@example.com | 總管 |  | manual | active | 是 |'));
  r = run('ask-first', '總管', '--off');
  ok('CLI ask-first --off：取消', r.action === 'ask-first-off' && r.entries.length === 1 && r.entries[0].askFirst === false);
  r = run('ask-first', '總管');
  ok('CLI ask-first：設上', r.action === 'ask-first-on' && r.entries[0].askFirst === true);
  r = run('ask-first', 'ALICE@example.com');
  ok('CLI ask-first：用 email 指定（大小寫不拘）', r.entries.length === 1 && r.entries[0].email === 'alice@example.com');
  run('ask-first', 'alice@example.com', '--off');
  r = run('sync', '--facts', factsPath);
  ok('CLI sync：同步之後先問人設定還在', r.contacts.find((c) => c.email === 'bot@example.com').askFirst === true && r.contacts.find((c) => c.email === 'alice@example.com').askFirst === false);
  let afCode = 0;
  try { execFileSync(process.execPath, [join(SCRIPTS, 'contacts.mjs'), 'ask-first', '路人'], { encoding: 'utf8', env, stdio: 'pipe' }); } catch (e) { afCode = e.status; }
  ok('CLI ask-first：找不到人 exit 1', afCode === 1);

  // 沒有 remove 對象 → exit 1
  let code = 0;
  try { execFileSync(process.execPath, [join(SCRIPTS, 'contacts.mjs'), 'remove', '路人'], { encoding: 'utf8', env, stdio: 'pipe' }); } catch (e) { code = e.status; }
  ok('CLI remove：找不到人 exit 1', code === 1);
}

// ── 結果 ─────────────────────────────────────────────────────────
for (const name of pass) console.log(`  ok  ${name}`);
console.log(`\n${pass.length} passed, ${fail.length} failed`);
rmSync(root, { recursive: true, force: true });
process.exit(fail.length ? 1 : 0);
