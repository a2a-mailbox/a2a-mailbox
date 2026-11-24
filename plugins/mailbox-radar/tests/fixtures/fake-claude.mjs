// 測試用的假 claude（classifier-auth.test.mjs 透過 MAILBOX_RADAR_CLAUDE_BIN 指到這裡）。
// 每次被呼叫都記一行到 FAKE_CLAUDE_LOG：參數與「有沒有拿到 token、拿到哪一張」。
// 行為由 FAKE_CLAUDE_MODE 決定：
//   ok           一律成功
//   token-bad    帶 token 就登入失敗，不帶 token 成功
//   login-bad    不帶 token 就登入失敗，帶 token 成功
//   all-bad      一律登入失敗
//   opus-busy    opus 模型回非登入類錯誤，其他模型成功
// `auth status` 一律印 FAKE_AUTH_STATUS（JSON 字串）。
import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const tok = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '';
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, tok }) + '\n');

if (args[0] === 'auth') {
  process.stdout.write((process.env.FAKE_AUTH_STATUS ?? '{}') + '\n');
  process.exit(0);
}

try { readFileSync(0); } catch {} // 把 stdin 讀完，免得呼叫端寫入時撞到關閉的管道
const model = args[args.indexOf('--model') + 1] ?? '';
const OK = '{"tier":0,"todo":false,"c1":true,"c2":true,"c3":true,"reason":"純資料問答"}';
const AUTH_FAIL = (msg) => { process.stdout.write(msg + '\n'); process.exit(1); };

switch (process.env.FAKE_CLAUDE_MODE) {
  case 'token-bad':
    if (tok) AUTH_FAIL('Failed to authenticate: OAuth token revoked · Please run /login');
    break;
  case 'login-bad':
    if (!tok) AUTH_FAIL('Failed to authenticate: OAuth session expired and could not be refreshed');
    break;
  case 'all-bad':
    AUTH_FAIL('Failed to authenticate: OAuth session expired and could not be refreshed');
    break;
  case 'opus-busy':
    if (model.includes('opus')) { process.stderr.write('API Error: 529 overloaded\n'); process.exit(1); }
    break;
  default:
    break;
}
process.stdout.write(OK + '\n');
