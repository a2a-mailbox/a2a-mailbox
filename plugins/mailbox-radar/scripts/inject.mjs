#!/usr/bin/env node
// team-mailbox-radar · 注入器
//
// 被 hooks.json 以 exec form 呼叫：
//   node inject.mjs --event SessionStart|PostToolUse
// stdin 收 harness 給的 hook payload（JSON）；stdout 印 hook JSON 輸出。
//
// 紀律：
//   * 沒有未讀 → 完全不輸出（stdout 空的），不製造雜訊
//   * 任何錯誤都靜默吞掉並 exit 0——注入是加分項，不能讓 hook 失敗干擾使用者的 session
//   * 一切狀態寫 $CLAUDE_PLUGIN_DATA，不寫進 plugin 安裝目錄（桌面版那是版本化快取）

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { detect } from './detect.mjs';
import { formatUnread } from './format.mjs';
import { loadState, pruneState, saveState } from './state.mjs';
import { FAIL_THRESHOLD, formatWarning, loadHealth, recordFailure, recordSuccess } from './health.mjs';
import { watcherStatus } from './paths.mjs';
import { configPath, ensureUserData } from './userdata.mjs';

// 搭便車注入的掃描節流：同一個 session 內，最短 SCAN_COOLDOWN_MS 才會再掃一次交換區。
// 掃一次只要 0.3 毫秒、零 token，所以節流不是為了省成本，是為了不在密集工具呼叫時
// 對 Drive 掛載連發 readdir。10 秒的上限對「30 分鐘太久」這個需求還有很大餘裕。
const SCAN_COOLDOWN_MS = 10_000;

const argv = process.argv.slice(2);
const event = (() => {
  const i = argv.indexOf('--event');
  return i >= 0 && argv[i + 1] ? argv[i + 1] : 'unknown';
})();

const dataDir = process.env.CLAUDE_PLUGIN_DATA
  || join(tmpdir(), 'mailbox-radar');

function trace(fields) {
  // 臨時觀測欄（2026-08-26 驗喚醒層前提，驗完可拆）：hook 行程拿不拿得到 socket
  fields = [...fields,
    `sock=${process.env.CLAUDE_CODE_MESSAGING_SOCKET ? '有' : '無'}`,
    `token=${process.env.CLAUDE_CODE_MESSAGING_TOKEN ? '有' : '無'}`];
  try {
    mkdirSync(dataDir, { recursive: true });
    appendFileSync(join(dataDir, 'radar-trace.log'),
      [new Date().toISOString(), event, ...fields].join('  ') + '\n');
  } catch {
    // 連 log 都寫不了也要靜默：hook 的失敗會顯示在使用者畫面上
  }
}

function readPayload() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({});
    let buf = '';
    const done = () => {
      try { resolve(buf.trim() ? JSON.parse(buf) : {}); } catch { resolve({}); }
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', done);
    process.stdin.on('error', () => resolve({}));
    setTimeout(done, 3000).unref();
  });
}

function emit(context) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: context },
  }) + '\n');
}

/**
 * 「裝好了但還沒設定」的開場指示。
 *
 * 0.5.x 的假設是 skill 與 plugin 分開裝，所以「沒有 config.md」代表使用者只裝了
 * plugin、還沒把 skill 複製過去，安靜退出是對的。0.6.0 把 skill 收進 plugin 之後
 * 這個假設不成立了：裝了 plugin 就一定有 skill，沒有 config.md 只代表還沒填設定。
 * 繼續安靜退出會讓使用者以為裝壞了（雷達完全沒反應、也不說為什麼），所以改成講一次。
 *
 * 只在 SessionStart 講。PostToolUse 維持安靜，否則每次工具呼叫都吵一遍。
 */
function firstRunGuidance() {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  const template = root
    ? join(root, 'skills', 'team-mailbox', 'config.md')
    : 'plugin 目錄下的 skills/team-mailbox/config.md';
  return [
    '【交換區信箱】信箱雷達已安裝，但還沒設定，所以目前沒有在監看任何交換區。',
    '',
    `請引導使用者建立 ${configPath()}，裡面需要三種欄位：`,
    '  名字：使用者在交換區的代稱，要跟他的收件匣資料夾後綴一致',
    '  交換區：交換區資料夾在這臺機器上的絕對路徑',
    '  白名單：一行一人，格式是「白名單：<Google email> <名字>」',
    '',
    `範本在 ${template}，可以複製過去再填。`,
    '名字與白名單要問使用者；交換區路徑可以自己找，通常在 Google Drive 掛載底下的 _交換區。',
    '設定完成後要開一個新對話才會生效。',
    '如果使用者現在不想處理，回一句知道了就好，不要打斷他手上的事。',
  ].join('\n');
}

// ── watcher spawn（Phase 2）──────────────────────────────────
// 每個 session 一支，detached；用 pid 檔防同一 session 重複 spawn
// （SessionStart 在 resume／compact 後可能再度觸發）。
function ensureWatcher(sessionId) {
  if (!process.env.CLAUDE_CODE_MESSAGING_SOCKET || !process.env.CLAUDE_CODE_MESSAGING_TOKEN) {
    return '無socket'; // headless 等宿主沒有喚醒路，環境層照常
  }
  try {
    const watchersDir = join(dataDir, 'watchers');
    mkdirSync(watchersDir, { recursive: true });
    // 清掃死行程的 pid 檔（0.4.4）：每 session 留一檔、行程死了檔不會自己消失，
    // 實測堆到 80 個。kill(pid, 0)＝只探測不殺，探不到就刪檔。
    try {
      for (const f of readdirSync(watchersDir)) {
        if (!f.endsWith('.pid')) continue;
        const p = Number(readFileSync(join(watchersDir, f), 'utf8').trim());
        try { process.kill(p, 0); } catch { try { unlinkSync(join(watchersDir, f)); } catch {} }
      }
    } catch {}
    const pidFile = join(watchersDir, `${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_')}.pid`);
    // 心跳過期＝這個 data dir 名下所有 watcher 都沒在動（心跳檔是共用的）。
    // 此時就算 pid 探得到，也視同「活著但卡死」（睡眠喚醒後的常見屍態，0.4.4，
    // 起因：2026-08-28 實測長壽 session 的 watcher 過夜卡死、pid 檔擋住重生，
    // 開著的對話整段時間收不到喚醒）。已知殘留限制：若「別的」session 的
    // watcher 還健康地跳著、本 session 的卡死，共用心跳看不出來——那種情況
    // 本 session 要等下一次 SessionStart 才復活。
    const stale = watcherStatus(dataDir) === 'stale';
    try {
      const oldPid = Number(readFileSync(pidFile, 'utf8').trim());
      if (oldPid > 0) {
        process.kill(oldPid, 0); // kill 0＝只探測不殺
        if (!stale) return '已在跑';
        try { process.kill(oldPid, 'SIGTERM'); } catch {} // 卡死屍體，殺掉重生
      }
    } catch {} // 沒 pid 檔或行程已死 → 往下 spawn
    const script = join(dirname(fileURLToPath(import.meta.url)), 'watcher.mjs');
    const child = spawn(process.execPath, [script, '--data', dataDir], {
      detached: true, stdio: 'ignore', windowsHide: true, // windowsHide：防 Windows 閃 console 視窗
    });
    child.unref();
    writeFileSync(pidFile, String(child.pid));
    return stale ? `復活 pid=${child.pid}` : `spawn pid=${child.pid}`;
  } catch (err) {
    return `spawn失敗=${String(err?.message ?? err)}`;
  }
}

async function main() {
  const payload = await readPayload();
  const sessionId = payload.session_id ?? 'unknown';
  const now = Date.now();

  // 同事件去重鎖（0.5.1 起是保險、不再是必需）：0.5.0 對每個事件掛 sh 與 node
  // 兩條進場路，mac 上會各起一支，靠這道鎖讓後到者退場。0.5.1 改成單一 shell 形式
  // 條目後理論上不會雙跑，但 Windows 探針量到「開兩個 session 實際觸發四次
  // SessionStart」（含壽命約 5 秒的輔助行程），保留這道鎖零成本、多一層穩。
  // 先到者工作，後到者看到 5 秒內的新鮮鎖就靜默退場。鎖失敗不擋事（寧可雙跑不可全滅）。
  try {
    const lockDir = join(dataDir, 'locks');
    mkdirSync(lockDir, { recursive: true });
    const lockFile = join(lockDir, `${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_')}-${event}.lock`);
    try {
      const prev = Number(readFileSync(lockFile, 'utf8'));
      if (Number.isFinite(prev) && now - prev < 5000) process.exit(0);
    } catch {}
    writeFileSync(lockFile, String(now));
  } catch {}

  if (event === 'SessionStart') {
    // 使用者資料搬遷（0.5.x 的 ~/.claude/skills/team-mailbox/ → ~/.claude/team-mailbox/）
    // 只在這裡做：每個 session 開場一次，冪等，而且是明確的寫入動作、不藏在取路徑後面。
    try {
      const moved = ensureUserData();
      if (moved.migrated.length > 0) trace([`使用者資料已搬遷=${moved.migrated.join(',')}`]);
    } catch (err) {
      trace([`搬遷失敗=${String(err?.message ?? err)}`]);
    }

    let result;
    try {
      result = detect();
    } catch (err) {
      trace([`detect 例外=${String(err?.message ?? err)}`]);
      process.exit(0);
    }
    if (!result.ok) {
      if (result.errorKind === 'config') {
        // 沒有 config.md＝裝好了但還沒設定（0.6.0 起 skill 隨 plugin 一起來，
        // 不再有「只裝 plugin 沒裝 skill」這種狀態）。開場提示一次，別讓人以為裝壞了。
        trace([`未設定=${result.error}`]);
        emit(firstRunGuidance());
        process.exit(0);
      }
      const w = ensureWatcher(sessionId); // 掛載可能恢復，watcher 照 spawn
      // 有裝但讀不到交換區：記一次失敗，達門檻就在開場講出來（task 6）
      const h = recordFailure(dataDir, result.error);
      trace([`watcher=${w}`]);
      trace([`偵測失敗=${result.error}`, `連續失敗=${h.consecutiveFailures}`]);
      const warning = formatWarning(h);
      if (warning) emit(warning);
      process.exit(0);
    }
    recordSuccess(dataDir);
    const w = ensureWatcher(sessionId);

    // 已讀回寫（Phase 3）：read.md 變了才鏡射到交換區彙總檔，沒變零成本
    try {
      const { syncReadback } = await import('./readback.mjs');
      syncReadback({ dataDir });
    } catch (err) {
      trace([`readback失敗=${String(err?.message ?? err)}`]);
    }

    let context = formatUnread(result, { mode: 'session', limit: 8 });
    // 通知器可見性（Phase 2）：心跳過期＝這臺機器現在沒有任何 monitor 在看信箱。
    // 'never'（從沒跑過）不警告——headless 或不支援 monitor 的宿主本來就沒有
    if (watcherStatus(dataDir) === 'stale') {
      const note = '【交換區信箱】⚠️ 通知器（watcher）心跳已超過 10 分鐘沒更新——訊息落地時不會再有主動喚醒，只剩開場與工具呼叫後的被動偵測。請用一句話告知使用者；重開一個對話通常會自動把它帶起來。';
      context = context ? context + '\n\n' + note : note;
    }

    // 開場注入的那批算「已告知」，之後搭便車只報這個 session 進行中新落地的
    pruneState(dataDir, now);
    saveState(dataDir, sessionId, {
      announced: new Set(result.unread.map((u) => u.file)),
      lastScanAt: now,
    });

    trace([
      `session=${sessionId}`,
      `未讀=${result.unreadCount}`,
      `已讀帳=${result.ledgerCount}`,
      `耗時=${result.elapsedMs.toFixed(2)}ms`,
      `注入=${context ? '是' : '否'}`,
      `watcher=${w}`,
    ]);
    if (context) emit(context);
    process.exit(0);
  }

  // ── PostToolUse：搭便車偵測 ──────────────────────────────────
  // 職責已在子 Plan 決策 3 降級為「watcher 死掉的安全網」：只報新落地的，
  // 沒有新東西就一個字都不輸出。
  const state = loadState(dataDir, sessionId);

  if (now - state.lastScanAt < SCAN_COOLDOWN_MS) {
    process.exit(0); // 節流期內：不掃、不輸出、不留痕跡（免得 log 被工具呼叫洗掉）
  }

  let result;
  try {
    result = detect();
  } catch (err) {
    trace([`detect 例外=${String(err?.message ?? err)}`]);
    process.exit(0);
  }
  if (!result.ok) {
    if (result.errorKind === 'config') {
      // 還沒設定。這裡不提示——開場已經講過一次，每次工具呼叫再講就是騷擾。
      trace([`未設定=${result.error}`]);
      process.exit(0);
    }
    const before = loadHealth(dataDir).consecutiveFailures;
    const h = recordFailure(dataDir, result.error);
    trace([`偵測失敗=${result.error}`, `連續失敗=${h.consecutiveFailures}`]);
    // 搭便車只在「剛跨過門檻」那一次警告（session 進行中壞掉的情況），
    // 之後每次工具呼叫都不再重複——持續狀態由下一次 SessionStart 接手
    if (before < FAIL_THRESHOLD && h.consecutiveFailures >= FAIL_THRESHOLD) {
      const warning = formatWarning(h);
      if (warning) emit(warning);
    }
    // 失敗也要推進 lastScanAt，不然節流失效、每次工具呼叫都去撞一次壞掉的掛載
    state.lastScanAt = now;
    saveState(dataDir, sessionId, state);
    process.exit(0);
  }
  recordSuccess(dataDir);

  // watcher 自我復活（0.4.4）：原本只有 SessionStart 會 spawn，長壽 session 的
  // watcher 死了就永遠沒人管。這裡在每次（節流後的）搭便車掃描順手檢查心跳，
  // 不健康就帶起來——「每個開著的對話都有一支活的 watcher」從此成立。
  if (watcherStatus(dataDir) !== 'alive') {
    trace([`watcher復活檢查=${ensureWatcher(sessionId)}`]);
  }

  const fresh = result.unread.filter((u) => !state.announced.has(u.file));
  state.lastScanAt = now;
  for (const u of fresh) state.announced.add(u.file);
  saveState(dataDir, sessionId, state);

  if (fresh.length === 0) {
    trace([`session=${sessionId}`, `tool=${payload.tool_name ?? '-'}`, `未讀=${result.unreadCount}`, '新落地=0', `耗時=${result.elapsedMs.toFixed(2)}ms`]);
    process.exit(0);
  }

  const context = formatUnread(
    { ...result, unread: fresh, unreadCount: fresh.length },
    { mode: 'inline', limit: 5 },
  );
  trace([
    `session=${sessionId}`,
    `tool=${payload.tool_name ?? '-'}`,
    `未讀=${result.unreadCount}`,
    `新落地=${fresh.length}`,
    `耗時=${result.elapsedMs.toFixed(2)}ms`,
    '注入=是',
  ]);
  if (context) emit(context);
  process.exit(0);
}

main();
