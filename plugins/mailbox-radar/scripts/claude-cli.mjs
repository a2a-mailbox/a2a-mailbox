// mailbox-radar · 呼叫 claude CLI 的唯一入口（0.10.0 從 classify.mjs 抽出）
//
// 分類器與開場的登入檢查都要在背景跑 claude，兩邊共用這一支，跨平臺的啟動細節只寫一次。
//
// 啟動順序：先無 shell 直呼，失敗才退 shell（Windows 原生安裝版 claude.exe 直呼也成功，
// 探針 2026-09-02 實測；所以不能寫死「Windows 一定要 shell」）。
//   mac／原生安裝版（claude 是執行檔）：無 shell 直接 spawn。
//   Windows npm 版（claude 是 .cmd shim）：無 shell 會 ENOENT 或 EINVAL
//   （Node 對 .cmd 的 CVE-2024-27980 防護），退一步走 shell。Node 24 對「shell:true ＋ 陣列參數」
//   會印 DEP0190 棄用警告，所以退路自己組單一命令字串。
//
// 安全前提（不靠呼叫端自律）：args 只准是程式碼常數與 models.mjs 註冊表值，
// 訊息內容永遠走 stdin——shell 退路的引號風險因此可控。
//
// 0.10.0 改用 spawnSync：成功時也拿得到 stderr（CLI 會把登入快結束的警告印在 stderr），
// 失敗時照舊丟出帶 stdout／stderr 的錯誤，呼叫端的錯誤處理不用改。
//
// 測試用覆寫：環境變數 MAILBOX_RADAR_CLAUDE_BIN 指到一支 .mjs 時，改用 node 跑那支假的 claude。
// 只給測試用，正式使用不要設。

import { spawnSync } from 'node:child_process';

function fail(r, label) {
  const err = new Error(r.error ? r.error.message : `Command failed: ${label}（exit ${r.status ?? r.signal}）`);
  err.code = r.error?.code;
  err.status = r.status;
  err.stdout = r.stdout ?? '';
  err.stderr = r.stderr ?? '';
  return err;
}

/**
 * 跑一次 claude。成功回 {stdout, stderr}；非零結束、逾時、啟動不了都丟錯（err.stdout／err.stderr 帶輸出）。
 * @param {string[]} args
 * @param {{input?: string, env?: object, timeout?: number}} [opts]
 */
export function runClaude(args, { input, env, timeout = 120_000 } = {}) {
  const base = { input, env, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 };
  const fake = process.env.MAILBOX_RADAR_CLAUDE_BIN;
  if (fake && fake.endsWith('.mjs')) {
    const r = spawnSync(process.execPath, [fake, ...args], base);
    if (r.error || r.status !== 0) throw fail(r, 'fake claude');
    return { stdout: r.stdout, stderr: r.stderr };
  }

  let r = spawnSync('claude', args, base);
  if (process.platform === 'win32' && (r.error?.code === 'ENOENT' || r.error?.code === 'EINVAL')) {
    const line = ['claude', ...args]
      .map((a) => `"${String(a).replace(/"/g, '\\"')}"`)
      .join(' ');
    r = spawnSync(line, { ...base, shell: true });
  }
  if (r.error || r.status !== 0) throw fail(r, 'claude');
  return { stdout: r.stdout, stderr: r.stderr };
}
