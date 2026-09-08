// 使用者資料目錄與搬遷的驗收測試（Phase 6 task 2）。跑法：
//   node tests/userdata.test.mjs
// 全部 assertion 過才 exit 0。測試資料寫在系統暫存目錄，**不碰真實的 ~/.claude**。
//
// 為什麼用動態 import 加隨機 query：userdata.mjs 的 USER_DATA_DIR 是模組載入時
// 從環境變數求值的常數，同一個模組實例改環境變數不會生效。每個情境要拿到乾淨的
// 模組實例，只能靠破 import 快取。
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = pathToFileURL(join(HERE, '..', 'scripts', 'userdata.mjs')).href;

const root = join(tmpdir(), 'mailbox-radar-userdata-test');
rmSync(root, { recursive: true, force: true });

const pass = [];
const fail = [];
const ok = (name, cond) => (cond ? pass : fail).push(name);

async function freshModule(userDir, legacyDir) {
  process.env.TEAM_MAILBOX_USER_DATA = userDir;
  process.env.TEAM_MAILBOX_LEGACY_DIR = legacyDir;
  return import(`${MODULE}?t=${Math.random()}`);
}

function makeCase(name) {
  const base = join(root, name);
  rmSync(base, { recursive: true, force: true });
  return {
    userDir: join(base, 'team-mailbox'),
    legacyDir: join(base, 'skills', 'team-mailbox'),
  };
}

// ── 情境 1：全新安裝（乾淨 HOME）─────────────────────────────
// Mac 驗收條件其一：乾淨 HOME 裝上 → 開場注入指示建設定。
// 這裡驗的是它的前提：目錄要備妥、而且 isConfigured 要回 false 讓 inject 去提示。
{
  const { userDir, legacyDir } = makeCase('case1-fresh');
  const m = await freshModule(userDir, legacyDir);
  const r = m.ensureUserData();

  ok('情境1 新位置被建立', existsSync(userDir));
  ok('情境1 沒有東西被搬', r.migrated.length === 0);
  ok('情境1 isConfigured 為 false（讓開場去提示建設定）', m.isConfigured() === false);
  ok('情境1 沒有亂留指標檔', !existsSync(join(legacyDir, '已搬遷至.md')));
}

// ── 情境 2：從舊位置搬遷 ────────────────────────────────────
// Mac 驗收條件其二：舊位置放 config.md ＋ read.md → 啟動後新位置齊全、舊位置只剩指標。
{
  const { userDir, legacyDir } = makeCase('case2-migrate');
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, 'config.md'), '名字：測試員\n交換區：/tmp/fake\n');
  writeFileSync(join(legacyDir, 'read.md'), '- 訊息_甲→測試員_主題_2026-01-01.md\n');
  // skill 本體：不該被搬走，也不該被複製過去
  writeFileSync(join(legacyDir, 'SKILL.md'), '# skill 本體\n');

  const m = await freshModule(userDir, legacyDir);
  const r = m.ensureUserData();

  ok('情境2 config.md 搬到新位置', existsSync(join(userDir, 'config.md')));
  ok('情境2 read.md 搬到新位置', existsSync(join(userDir, 'read.md')));
  ok('情境2 內容完整搬過去', readFileSync(join(userDir, 'config.md'), 'utf8').includes('測試員'));
  ok('情境2 舊位置的 config.md 已移走', !existsSync(join(legacyDir, 'config.md')));
  ok('情境2 舊位置的 read.md 已移走', !existsSync(join(legacyDir, 'read.md')));
  ok('情境2 留下指標檔', existsSync(join(legacyDir, '已搬遷至.md')));
  ok('情境2 指標檔指向新位置', readFileSync(join(legacyDir, '已搬遷至.md'), 'utf8').includes(userDir));
  ok('情境2 SKILL.md 留在原地沒被搬', existsSync(join(legacyDir, 'SKILL.md')));
  ok('情境2 SKILL.md 沒被複製到新位置', !existsSync(join(userDir, 'SKILL.md')));
  ok('情境2 回報搬了兩個檔', r.migrated.length === 2);
  ok('情境2 isConfigured 為 true', m.isConfigured() === true);

  // 「舊位置只剩指標」——skill 本體是刻意留的，所以是指標＋SKILL.md 兩個
  const left = readdirSync(legacyDir);
  ok('情境2 舊位置只剩指標與 skill 本體',
    left.length === 2 && left.includes('已搬遷至.md') && left.includes('SKILL.md'));

  // 冪等：同一個實例再跑不會重複動作
  ok('情境2 同實例重複呼叫不再搬', m.ensureUserData().migrated.length === 0);

  // 冪等：模擬下一次啟動（新實例、舊位置已無 config.md）
  const m2 = await freshModule(userDir, legacyDir);
  ok('情境2 下次啟動不重複搬', m2.ensureUserData().migrated.length === 0);
  ok('情境2 下次啟動仍讀得到設定', m2.isConfigured() === true);
}

// ── 情境 3：新舊位置都有 config.md（不覆蓋新的）──────────────
// 使用者可能已經在新位置手動建過設定，這時舊的殘留不該蓋掉它。
{
  const { userDir, legacyDir } = makeCase('case3-no-overwrite');
  mkdirSync(legacyDir, { recursive: true });
  mkdirSync(userDir, { recursive: true });
  writeFileSync(join(legacyDir, 'config.md'), '名字：舊的\n交換區：/tmp/old\n');
  writeFileSync(join(userDir, 'config.md'), '名字：新的\n交換區：/tmp/new\n');

  const m = await freshModule(userDir, legacyDir);
  const r = m.ensureUserData();

  ok('情境3 新位置的設定沒被覆蓋',
    readFileSync(join(userDir, 'config.md'), 'utf8').includes('新的'));
  ok('情境3 衝突的檔案回報為 skipped', r.skipped.includes('config.md'));
  ok('情境3 舊位置的檔案留在原地', existsSync(join(legacyDir, 'config.md')));
}

// ── 情境 4：路徑輔助函式 ────────────────────────────────────
{
  const { userDir, legacyDir } = makeCase('case4-paths');
  const m = await freshModule(userDir, legacyDir);

  ok('情境4 configPath 指向新位置', m.configPath() === join(userDir, 'config.md'));
  ok('情境4 ledgerPath 指向新位置', m.ledgerPath() === join(userDir, 'read.md'));
  ok('情境4 contactsPath 指向新位置', m.contactsPath() === join(userDir, '通訊錄.md'));
}

// ── 情境 5：取路徑不得有副作用（回歸測試）───────────────────
// 這條擋的是一個實際發生過的事故：configPath() 曾經在內部呼叫 ensureUserData()，
// 於是任何純查詢——跑測試、畫狀態列、CLI 查一下——都會把使用者的 config.md 搬走，
// 導致當時正在運作的舊版雷達瞬間讀不到設定。取路徑必須是唯讀的，搬遷只能明確觸發。
{
  const { userDir, legacyDir } = makeCase('case5-no-side-effect');
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, 'config.md'), '名字：測試員\n交換區：/tmp/fake\n');

  const m = await freshModule(userDir, legacyDir);

  // 只做查詢，不呼叫 ensureUserData()
  const p = m.configPath();
  const configured = m.isConfigured();

  ok('情境5 純查詢不會搬走舊位置的檔案', existsSync(join(legacyDir, 'config.md')));
  ok('情境5 純查詢不會建立指標檔', !existsSync(join(legacyDir, '已搬遷至.md')));
  ok('情境5 尚未搬遷時 configPath 退回舊位置', p === join(legacyDir, 'config.md'));
  ok('情境5 尚未搬遷時 isConfigured 仍答對', configured === true);

  // 明確呼叫搬遷之後才動
  m.ensureUserData();
  ok('情境5 明確搬遷後檔案才移到新位置', existsSync(join(userDir, 'config.md')));
  ok('情境5 明確搬遷後 configPath 改指新位置', m.configPath() === join(userDir, 'config.md'));
}

// ── 結果 ────────────────────────────────────────────────────
for (const name of pass) console.log(`  ok  ${name}`);
for (const name of fail) console.log(`FAIL  ${name}`);
console.log(`\n${pass.length} passed, ${fail.length} failed`);
rmSync(root, { recursive: true, force: true });
process.exit(fail.length ? 1 : 0);
