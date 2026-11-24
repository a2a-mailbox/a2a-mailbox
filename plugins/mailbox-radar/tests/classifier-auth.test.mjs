// 分類器專用登入（0.10.0）的驗收測試。跑法：
//   node tests/classifier-auth.test.mjs
// 全部 assertion 過才 exit 0。測試資料寫在系統暫存目錄，**不碰真實的 ~/.claude**；
// claude 用 tests/fixtures/fake-claude.mjs 頂替，不會真的呼叫模型。
//
// 環境變數要在 import 之前設好：userdata.mjs 的 USER_DATA_DIR 是模組載入時求值的常數。
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const root = join(tmpdir(), 'mailbox-radar-classifier-auth-test');
rmSync(root, { recursive: true, force: true });
const userDir = join(root, 'user');
const dataDir = join(root, 'data');
const log = join(root, 'calls.log');
mkdirSync(userDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });

process.env.TEAM_MAILBOX_USER_DATA = userDir;
process.env.TEAM_MAILBOX_LEGACY_DIR = join(root, 'legacy');
process.env.MAILBOX_RADAR_DATA = dataDir;
process.env.MAILBOX_RADAR_CLAUDE_BIN = join(HERE, 'fixtures', 'fake-claude.mjs');
process.env.FAKE_CLAUDE_LOG = log;
delete process.env.CLAUDE_CODE_OAUTH_TOKEN; // 跑測試的機器若自己設了，會干擾「沒設 token」的情境
delete process.env.MAILBOX_RADAR_MODEL_CLASSIFIER;

const A = await import('../scripts/classifier-auth.mjs');
const { classify, CLASSIFIER_HEALTH } = await import('../scripts/classify.mjs');

const pass = [];
const fail = [];
const ok = (name, cond) => (cond ? pass : fail).push(name);

const DAY = 24 * 60 * 60 * 1000;
const GOOD = 'sk-ant-oat01-' + 'A'.repeat(60);
const msgFile = join(root, '訊息_測試.md');
writeFileSync(msgFile, '---\nfrom: 某人\n---\n報告放在哪？\n');
const healthFile = join(dataDir, CLASSIFIER_HEALTH);

function calls() {
  try { return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}
function reset(mode) {
  rmSync(log, { force: true });
  rmSync(healthFile, { force: true });
  process.env.FAKE_CLAUDE_MODE = mode;
}
function health() {
  try { return JSON.parse(readFileSync(healthFile, 'utf8')); } catch { return null; }
}

// ── 1. 取 token：容忍貼上的雜訊，擋掉不對的東西 ─────────────────────
ok('1a 純 token', A.parseToken(GOOD).token === GOOD);
ok('1b 前後空白與換行', A.parseToken(`  ${GOOD}\r\n`).token === GOOD);
ok('1c 整行 export VAR=token', A.parseToken(`export CLAUDE_CODE_OAUTH_TOKEN=${GOOD}`).token === GOOD);
ok('1d 引號包住', A.parseToken(`"${GOOD}"`).token === GOOD);
ok('1e API 金鑰被擋', A.parseToken('sk-ant-api03-' + 'B'.repeat(60)).token === null);
ok('1f 太短被擋', A.parseToken('abc').token === null);
ok('1g 兩串被擋', A.parseToken(`${GOOD} ${GOOD}x`).token === null);
ok('1h 空字串被擋', A.parseToken('').token === null);

// ── 2. 存、讀、刪 ────────────────────────────────────────────────
ok('2a 沒設時讀到 null', A.readClassifierToken() === null);
const now = Date.parse('2026-11-24T08:00:00Z');
ok('2b 存成功', A.saveClassifierToken(GOOD, now).ok === true);
ok('2c 檔案在使用者資料目錄', A.TOKEN_FILE === join(userDir, 'classifier-token.json') && existsSync(A.TOKEN_FILE));
if (process.platform !== 'win32') ok('2d 權限 0600', (statSync(A.TOKEN_FILE).mode & 0o777) === 0o600);
const r0 = A.readClassifierToken(now + 10 * DAY);
ok('2e 讀回同一張、算出天數', r0.token === GOOD && r0.ageDays === 10 && r0.daysLeft === 355);
ok('2f 存不合格的不覆寫', A.saveClassifierToken('sk-ant-api03-' + 'B'.repeat(60)).ok === false
  && A.readClassifierToken().token === GOOD);
writeFileSync(A.TOKEN_FILE, '{壞掉');
ok('2g 壞檔回 error', typeof A.readClassifierToken()?.error === 'string');
ok('2h 刪除', A.clearClassifierToken() === true && A.readClassifierToken() === null);

// ── 3. 分類器：沒設 token ─────────────────────────────────────────
reset('ok');
let r = classify(msgFile);
let c = calls();
ok('3a 沒 token 照常成功、標 login', r.ok && r.auth === 'login' && r.tier === 0);
ok('3b 子程式沒拿到 token', c.length === 1 && c[0].tok === '');
ok('3c 成功後沒有健康記號', health() === null);

reset('login-bad');
r = classify(msgFile);
c = calls();
ok('3d 登入失效 → fail-closed', r.ok === false && r.tier === 2 && r.todo === true);
ok('3e 登入錯誤只試一次，不再換三個模型白試', c.length === 1);
let h = health();
ok('3f 健康記號：失敗、像登入問題、試過 login', h && h.ok === false && h.authLike === true
  && JSON.stringify(h.tried) === '["login"]');

reset('opus-busy');
r = classify(msgFile);
c = calls();
ok('3g 非登入錯誤照舊換下一個模型', r.ok && r.model.includes('sonnet') && r.degraded === true && c.length === 2);

// ── 4. 分類器：有 token ───────────────────────────────────────────
A.saveClassifierToken(GOOD);
reset('login-bad');
r = classify(msgFile);
c = calls();
ok('4a 有 token 就用 token、終端機登入壞了也不影響', r.ok && r.auth === 'token' && c.length === 1 && c[0].tok === GOOD);
ok('4b 用 token 成功沒有健康記號', health() === null);

reset('token-bad');
r = classify(msgFile);
c = calls();
ok('4c token 被拒 → 退回終端機登入、照常分類', r.ok && r.auth === 'login' && r.degraded === true);
ok('4d 先 token 一次、再 login 一次', c.length === 2 && c[0].tok === GOOD && c[1].tok === '');
h = health();
ok('4e 健康記號留著：成功但 token 被拒', h && h.ok === true && h.tokenFailed === true);

reset('all-bad');
r = classify(msgFile);
c = calls();
ok('4f 兩份都不能用 → fail-closed', r.ok === false && c.length === 2);
h = health();
ok('4g 健康記號：兩份都試過', h && h.ok === false && JSON.stringify(h.tried) === '["token","login"]');

// ── 5. 使用者自己設了環境變數 ──────────────────────────────────────
A.clearClassifierToken();
process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-' + 'E'.repeat(60);
reset('ok');
r = classify(msgFile);
ok('5a 標成 env-token', r.ok && r.auth === 'env-token');
ok('5b 沒設 token 檔時不對環境變數使用者做登入預警', A.authOutlookNote(dataDir, '/x', now) === null);
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

// ── 6. 開場提示文字 ──────────────────────────────────────────────
const S = '/plugin/scripts';
const hn1 = A.healthNote({ at: '2026-11-24T01:00:00Z', ok: false, authLike: true, tried: ['login'] }, S);
ok('6a 登入失效：兩種修法都講、附設定方法', hn1.includes('claude auth login') && hn1.includes('claude setup-token')
  && hn1.includes('classifier-auth.mjs') && hn1.includes('--set'));
ok('6b 提醒不要把 token 貼進對話', hn1.includes('不要請使用者把 token 貼給你'));
const hn2 = A.healthNote({ at: '2026-11-24T01:00:00Z', ok: true, tokenFailed: true, tried: ['token', 'login'] }, S);
ok('6c token 被拒但登入頂上：講還能運作、要換 token', hn2.includes('還能運作') && hn2.includes('重新產一張'));
const hn3 = A.healthNote({ at: '2026-11-24T01:00:00Z', ok: false, authLike: true, tried: ['token', 'login'] }, S);
ok('6d 兩份都壞：講 token 被拒', hn3.includes('token 被拒絕'));
const hn4 = A.healthNote({ at: '2026-11-24T01:00:00Z', ok: false, authLike: false, detail: 'ENOENT claude' }, S);
ok('6e 非登入問題：附原因', hn4.includes('ENOENT claude') && !hn4.includes('setup-token'));
const hnOld = A.healthNote({ at: '2026-11-24T01:00:00Z', authLike: true, detail: 'x' }, S);
ok('6f 舊版記號（沒有 ok、tried 欄位）照樣講得出登入修法', hnOld.includes('claude auth login'));

ok('6g token 還很新：不提示', A.tokenExpiryNote({ token: GOOD, savedAt: '2026-11-01', ageDays: 20, daysLeft: 345 }, S) === null);
ok('6h token 剩 20 天：提示', A.tokenExpiryNote({ token: GOOD, savedAt: '2025-12-10', ageDays: 345, daysLeft: 20 }, S)?.includes('20 天後到期'));
ok('6i token 超過一年：講可能已到期', A.tokenExpiryNote({ token: GOOD, savedAt: '2025-11-01', ageDays: 388, daysLeft: -23 }, S)?.includes('可能已經到期'));
ok('6j token 檔壞掉：提示重設', A.tokenExpiryNote({ error: '讀不了' }, S)?.includes('重新設定'));

const st = (days) => ({ loggedIn: true, authMethod: 'claude.ai', loginExpiresAt: new Date(now + days * DAY).toISOString() });
ok('6k 登入還有 20 天：不提示', A.loginExpiryNote(st(20), now, S) === null);
ok('6l 登入剩 5 天：提示並附兩種修法', (() => { const n = A.loginExpiryNote(st(5), now, S); return n?.includes('最晚') && n.includes('claude auth login') && n.includes('--set'); })());
ok('6m 登入已結束：講已經結束', A.loginExpiryNote(st(-2), now, S)?.includes('已經在'));
ok('6n 沒登入：提示', A.loginExpiryNote({ loggedIn: false }, now, S)?.includes('沒有登入'));
ok('6o 用 API 金鑰的人：不提示', A.loginExpiryNote({ loggedIn: true, authMethod: 'api_key', loginExpiresAt: new Date(now).toISOString() }, now, S) === null);
ok('6p 舊版 CLI 沒有結束日欄位：不提示', A.loginExpiryNote({ loggedIn: true, authMethod: 'claude.ai' }, now, S) === null);

// ── 7. 登入狀態的快取 ────────────────────────────────────────────
rmSync(join(dataDir, A.LOGIN_STATUS_FILE), { force: true });
reset('ok');
process.env.FAKE_AUTH_STATUS = JSON.stringify({ ...st(25), email: 'x@example.com' });
const s1 = A.loginStatus(dataDir, now);
const s2 = A.loginStatus(dataDir, now + 60 * 60 * 1000);
ok('7a 第一次真的去問、只留需要的欄位', s1?.loggedIn === true && s1.loginExpiresAt && s1.email === undefined);
ok('7b 一小時內第二次用快取，不再呼叫', calls().length === 1 && s2?.loginExpiresAt === s1.loginExpiresAt);
A.loginStatus(dataDir, now + 7 * 60 * 60 * 1000);
ok('7c 超過六小時重新問', calls().length === 2);

rmSync(join(dataDir, A.LOGIN_STATUS_FILE), { force: true });
reset('ok');
process.env.FAKE_AUTH_STATUS = JSON.stringify(st(3));
A.loginStatus(dataDir, now);
A.loginStatus(dataDir, now + 15 * 60 * 1000);
ok('7d 正在警告的狀態只快取 10 分鐘（重登後警告很快消失）', calls().length === 2);

rmSync(join(dataDir, A.LOGIN_STATUS_FILE), { force: true });
reset('ok');
process.env.FAKE_AUTH_STATUS = JSON.stringify(st(3));
const outlook = A.authOutlookNote(dataDir, S, now);
ok('7e 沒設 token 且登入快結束：開場預警', outlook?.includes('最晚'));
A.saveClassifierToken(GOOD, now);
ok('7f 設了 token 就不看終端機登入', A.authOutlookNote(dataDir, S, now) === null);
A.clearClassifierToken();

// ── 結果 ────────────────────────────────────────────────────
for (const name of pass) console.log(`  ok  ${name}`);
for (const name of fail) console.log(`FAIL  ${name}`);
console.log(`\n${pass.length} passed, ${fail.length} failed`);
rmSync(root, { recursive: true, force: true });
process.exit(fail.length ? 1 : 0);
