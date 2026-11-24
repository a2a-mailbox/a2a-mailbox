#!/usr/bin/env node
// mailbox-radar · 分類器專用登入（0.10.0）
//
// 為什麼要有這支：
//   分類器在背景另外啟動一支 `claude -p`。那支子程式不會沿用桌面版的登入，讀的是終端機版
//   存在本機的那一份登入。那份登入有固定結束日（實測約四週，有在用也不會延長），也可能因為
//   續期失敗被整份清掉。平常不開終端機的人，壞了沒有人會看到，分類器就每封都 fail-closed 成
//   「先問本人」，自動代答形同停擺。官方給無人值守工作的做法，是用 `claude setup-token`
//   產一張一年效期的 token，經環境變數 CLAUDE_CODE_OAUTH_TOKEN 交給 claude。
//
// 為什麼只塞給分類器的子程式，不叫使用者把它設成全域環境變數：
//   這種 token 只能做模型請求，抓不到 claude.ai 的連接器。設成全域的話，終端機版 Claude 的
//   每個對話都會改用它，連接器全部消失（2026-09 實測過）。分類器本來就禁用所有工具，不受影響。
//   0.7.x 曾因為「重新登入就能跑」決定不做這支；後來證實登入約四週就會結束、也有機器幾乎
//   每天失效，前提不成立，所以 0.10.0 改做。
//
// 存放：使用者資料目錄的 classifier-token.json（plugin 更新不會清掉），權限 0600。
//
// 用法（在自己的終端機跑，不要在 Claude 的對話框裡跑，token 會進對話紀錄）：
//   node classifier-auth.mjs --set      從標準輸入讀 token（貼上後按 Enter）
//   node classifier-auth.mjs --status   有沒有設、哪天存的、約何時到期（不印 token）
//   node classifier-auth.mjs --check    用 token 實際呼叫一次模型，確認可用
//   node classifier-auth.mjs --clear    刪除

import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { USER_DATA_DIR } from './userdata.mjs';
import { runClaude } from './claude-cli.mjs';
import { MODELS } from './models.mjs';

export const TOKEN_FILE = join(USER_DATA_DIR, 'classifier-token.json');
// 官方文件：setup-token 產的是 one-year token。實際到期日從 token 本身讀不出來，以存入日推算。
export const TOKEN_LIFETIME_DAYS = 365;
const TOKEN_WARN_DAYS = 30;
// 一般登入的結束日在 CLI 是一個區間（最早與最晚差約三天），CLI 自己從最晚日前 10 天開始警告，這裡對齊。
const LOGIN_WARN_DAYS = 10;
// 開場的登入檢查要跑一次 claude（約 0.2 秒），結果快取；正在警告的狀態只快取 10 分鐘，
// 使用者重新登入後警告能很快消失。
const LOGIN_CACHE_MS = 6 * 60 * 60 * 1000;
const LOGIN_CACHE_WARN_MS = 10 * 60 * 1000;
export const LOGIN_STATUS_FILE = 'login-status.json';
const DAY = 24 * 60 * 60 * 1000;

/** 從貼上的文字取出 token。容忍前後空白、引號，或整行 `VAR=token`。取不到回 null 並附理由。 */
export function parseToken(text) {
  const s = String(text ?? '').trim().replace(/^['"]|['"]$/g, '');
  if (/sk-ant-api/i.test(s)) return { token: null, why: '這是 API 金鑰，不是 claude setup-token 產生的 token' };
  const found = s.match(/sk-ant-[A-Za-z0-9_-]{20,}/g) ?? [];
  if (found.length > 1) return { token: null, why: '貼上的內容裡有不只一串 token，請只貼一串' };
  if (found.length === 1) return { token: found[0], why: null };
  if (/^[A-Za-z0-9._-]{30,}$/.test(s)) return { token: s, why: null };
  return { token: null, why: '看不出是 token（太短，或含空白等不該有的字元）' };
}

/** 存 token。回 {ok, why?}。 */
export function saveClassifierToken(text, now = Date.now()) {
  const { token, why } = parseToken(text);
  if (!token) return { ok: false, why };
  mkdirSync(dirname(TOKEN_FILE), { recursive: true });
  writeFileSync(TOKEN_FILE, JSON.stringify({ token, savedAt: new Date(now).toISOString() }) + '\n', { mode: 0o600 });
  try { chmodSync(TOKEN_FILE, 0o600); } catch {}
  return { ok: true };
}

/**
 * 讀 token。沒設回 null；檔案壞掉回 {error}（呼叫端照沒設處理，但要讓人知道）。
 * @returns {null | {error: string} | {token: string, savedAt: string, ageDays: number, daysLeft: number}}
 */
export function readClassifierToken(now = Date.now()) {
  if (!existsSync(TOKEN_FILE)) return null;
  try {
    const j = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
    if (!j.token) return { error: 'classifier-token.json 裡沒有 token 欄位' };
    const saved = Date.parse(j.savedAt);
    const ageDays = Number.isFinite(saved) ? Math.floor((now - saved) / DAY) : 0;
    return { token: j.token, savedAt: j.savedAt ?? null, ageDays, daysLeft: TOKEN_LIFETIME_DAYS - ageDays };
  } catch (err) {
    return { error: `classifier-token.json 讀不了：${err.message}` };
  }
}

export function clearClassifierToken() {
  try { unlinkSync(TOKEN_FILE); return true; } catch { return false; }
}

/** 給子程式的環境：沿用目前環境，只多塞 token。 */
export function envWithToken(token) {
  return { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token };
}

// ── 開場提示的文字（純函式，測試直接驗） ───────────────────────────────

function localDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function localStamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso ?? '');
  const p = (n) => String(n).padStart(2, '0');
  return `${localDate(d.getTime())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 設定方法。給代理人原樣轉給使用者。 */
export function setupHowTo(scriptsDir) {
  const cmd = `node "${join(scriptsDir, 'classifier-auth.mjs')}" --set`;
  return [
    '設定分類器專用 token 的方法（約兩分鐘，一年一次）：',
    '1. 開一個終端機視窗（不是 Claude 的對話框），跑 `claude setup-token`，瀏覽器授權後終端機會印出一串 token。',
    `2. 複製那串 token，在同一個終端機跑 \`${cmd}\`，貼上後按 Enter。`,
    '3. 不要把 token 設成全域環境變數，也不要貼進 Claude 的對話裡。',
    '轉告時請把上面三步原樣給使用者；不要請使用者把 token 貼給你。',
  ].join('\n');
}

const NEED_RELAY = '請用一句話告知使用者。';

/** 分類器健康記號 → 開場提示。h 是 classify.mjs 寫的 classifier-health.json。 */
export function healthNote(h, scriptsDir) {
  const when = localStamp(h.at);
  if (h.ok && h.tokenFailed) {
    return [
      `【交換區信箱】⚠️ 分類器專用 token 在 ${when} 被拒絕了，這次改用終端機版的登入頂上，所以自動代答還能運作。${NEED_RELAY}`,
      '終端機版的登入大約四週就會結束，結束後分類器會整個停擺。請使用者重新產一張 token。',
      setupHowTo(scriptsDir),
    ].join('\n');
  }
  const head = `【交換區信箱】⚠️ 自動代答的分類器在 ${when} 整個跑不起來。在修好之前，收到的每一封都會當成「先問過本人才處理」，不會自動回。${NEED_RELAY}`;
  if (!h.authLike) return [head, `原因：${String(h.detail ?? '').slice(0, 300)}`].join('\n');
  if ((h.tried ?? []).includes('token')) {
    return [
      head,
      '分類器專用 token 被拒絕了（可能過期或被撤銷），終端機版的登入也不能用。請使用者重新產一張 token。',
      setupHowTo(scriptsDir),
    ].join('\n');
  }
  return [
    head,
    '原因是終端機版 Claude 的登入失效或到期了（桌面版的登入不算，分類器用不到）。兩種修法：',
    '- 建議：給分類器設一張一年期的專用 token，之後就不受終端機登入影響。',
    '- 立刻恢復：開終端機跑 `claude auth login` 重新登入。這份登入大約四週後又會結束。',
    setupHowTo(scriptsDir),
  ].join('\n');
}

/** token 快到期（以存入日推算）→ 開場提示；不用提示回 null。 */
export function tokenExpiryNote(info, scriptsDir) {
  if (!info) return null;
  if (info.error) {
    return [
      `【交換區信箱】⚠️ 分類器專用 token 的檔案讀不了（${info.error}），分類器改用終端機版的登入。${NEED_RELAY}`,
      '請使用者重新設定一次。',
      setupHowTo(scriptsDir),
    ].join('\n');
  }
  if (info.daysLeft > TOKEN_WARN_DAYS) return null;
  const head = info.daysLeft <= 0
    ? `【交換區信箱】⚠️ 分類器專用 token 是 ${localStamp(info.savedAt)} 存的，以一年效期推算可能已經到期。${NEED_RELAY}`
    : `【交換區信箱】分類器專用 token 以一年效期推算，大約 ${info.daysLeft} 天後到期。${NEED_RELAY}`;
  return [head, '請使用者重新產一張換上。', setupHowTo(scriptsDir)].join('\n');
}

/** 沒設 token 時，看終端機版登入的狀態 → 開場提示；不用提示回 null。status 是 `claude auth status` 的 JSON。 */
export function loginExpiryNote(status, now, scriptsDir) {
  if (!status) return null;
  if (status.loggedIn === false) {
    return [
      `【交換區信箱】⚠️ 終端機版 Claude 沒有登入，自動代答的分類器跑不起來，收到的每一封都會當成「先問過本人才處理」。${NEED_RELAY}`,
      '修法二選一：給分類器設一張一年期的專用 token（建議），或開終端機跑 `claude auth login` 登入（大約四週後要再登一次）。',
      setupHowTo(scriptsDir),
    ].join('\n');
  }
  if (status.authMethod && status.authMethod !== 'claude.ai') return null;
  const end = Date.parse(status.loginExpiresAt);
  if (!Number.isFinite(end)) return null;
  const daysLeft = Math.floor((end - now) / DAY);
  if (daysLeft > LOGIN_WARN_DAYS) return null;
  const head = daysLeft < 0
    ? `【交換區信箱】⚠️ 終端機版 Claude 的登入已經在 ${localDate(end)} 結束，自動代答的分類器會跑不起來。${NEED_RELAY}`
    : `【交換區信箱】⚠️ 終端機版 Claude 的登入最晚 ${localDate(end)} 結束，可能提早幾天。結束後自動代答的分類器會跑不起來，每一封都變成要本人決定。${NEED_RELAY}`;
  return [
    head,
    '修法二選一：給分類器設一張一年期的專用 token（建議，之後就不用管），或在那之前開終端機跑 `claude auth login` 重新登入（大約四週後要再登一次）。',
    setupHowTo(scriptsDir),
  ].join('\n');
}

/**
 * 終端機版登入的狀態，帶快取。跑不了、看不懂都回 null（開場提示是加分項，不能卡住開場）。
 * @returns {null | {loggedIn?: boolean, authMethod?: string, loginExpiresAt?: string}}
 */
export function loginStatus(dataDir, now = Date.now()) {
  const file = join(dataDir, LOGIN_STATUS_FILE);
  try {
    const c = JSON.parse(readFileSync(file, 'utf8'));
    const warn = loginExpiryNote(c.status, now, '.') !== null;
    if (now - c.checkedAt < (warn ? LOGIN_CACHE_WARN_MS : LOGIN_CACHE_MS)) return c.status;
  } catch {}
  let status = null;
  try {
    const { stdout } = runClaude(['auth', 'status'], { timeout: 5000 });
    const j = JSON.parse(stdout.slice(stdout.indexOf('{')));
    status = { loggedIn: j.loggedIn, authMethod: j.authMethod, loginExpiresAt: j.loginExpiresAt };
  } catch (err) {
    // `claude auth status` 沒登入時會非零結束，但 stdout 仍是 JSON
    try {
      const out = String(err.stdout ?? '');
      const j = JSON.parse(out.slice(out.indexOf('{')));
      status = { loggedIn: j.loggedIn, authMethod: j.authMethod, loginExpiresAt: j.loginExpiresAt };
    } catch { return null; }
  }
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file, JSON.stringify({ checkedAt: now, status }));
  } catch {}
  return status;
}

/** 開場要講的分類器登入提示（健康記號以外的部分）。沒有要講的回 null。 */
export function authOutlookNote(dataDir, scriptsDir, now = Date.now()) {
  const info = readClassifierToken(now);
  if (info) return tokenExpiryNote(info, scriptsDir);
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return null; // 使用者自己用環境變數給了 token，不干涉
  return loginExpiryNote(loginStatus(dataDir, now), now, scriptsDir);
}

// ── 指令列 ────────────────────────────────────────────────────────────

function readInput() {
  if (!process.stdin.isTTY) {
    try { return readFileSync(0, 'utf8'); } catch { return ''; }
  }
  return new Promise((resolve) => {
    process.stderr.write('貼上 claude setup-token 印出的 token，然後按 Enter：');
    const rl = createInterface({ input: process.stdin });
    rl.once('line', (line) => { rl.close(); resolve(line); });
  });
}

function printStatus() {
  const info = readClassifierToken();
  if (!info) { console.log('分類器專用 token：沒有設定。分類器使用終端機版 Claude 的登入。'); return; }
  if (info.error) { console.log(`分類器專用 token：檔案有問題（${info.error}）。`); return; }
  console.log(`分類器專用 token：已設定（${localStamp(info.savedAt)} 存入，以一年效期推算約剩 ${info.daysLeft} 天）。`);
  console.log(`位置：${TOKEN_FILE}`);
}

function check() {
  const info = readClassifierToken();
  if (!info || info.error) { console.log('沒有可用的分類器專用 token，先跑 --set。'); return 1; }
  const model = MODELS.classifier.candidates.at(-1); // 只是確認登入，用最便宜的那個
  try {
    const { stdout } = runClaude(
      ['-p', '--model', model, '--max-turns', '1', '--disallowed-tools', '*'],
      { input: '只回 ok 兩個字母。', env: envWithToken(info.token), timeout: 60_000 });
    console.log(`可用：用 token 呼叫 ${model} 成功（回覆：${stdout.trim().slice(0, 40)}）。`);
    return 0;
  } catch (err) {
    const detail = [err.stdout, err.stderr].map((x) => String(x ?? '').trim()).filter(Boolean).join('｜');
    console.log(`不可用：${detail.slice(0, 300) || err.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flag = process.argv[2];
  if (flag === '--set') {
    const r = saveClassifierToken(await readInput());
    if (!r.ok) { console.log(`沒有存：${r.why}。`); process.exit(1); }
    printStatus();
    console.log('建議接著跑 --check 確認 token 真的能用。');
    process.exit(0);
  } else if (flag === '--status') {
    printStatus(); process.exit(0);
  } else if (flag === '--check') {
    process.exit(check());
  } else if (flag === '--clear') {
    console.log(clearClassifierToken() ? '已刪除分類器專用 token。' : '本來就沒有設定。');
    process.exit(0);
  } else {
    console.error(`用法：node ${join(dirname(fileURLToPath(import.meta.url)), 'classifier-auth.mjs')} --set|--status|--check|--clear`);
    process.exit(2);
  }
}
