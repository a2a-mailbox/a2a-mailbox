#!/usr/bin/env node
// mailbox-radar · 注入器
//
// 被 hooks.json 以 shell 形式呼叫（0.5.1 起）：
//   sh noderun.sh inject.mjs --event SessionStart|PostToolUse
// stdin 收 harness 給的 hook payload（JSON）；stdout 印 hook JSON 輸出。
//
// 紀律：
//   * 沒有未讀 → 完全不輸出（stdout 空的），不製造雜訊
//   * 任何錯誤都靜默吞掉並 exit 0——注入是加分項，不能讓 hook 失敗干擾使用者的 session
//   * 一切狀態寫 data dir（0.6.0 起收斂為 paths.mjs 的單一固定路徑，不再看 CLAUDE_PLUGIN_DATA——
//     桌面版／CLI 給的值不同會長出兩個平行宇宙），不寫進 plugin 安裝目錄（桌面版那是版本化快取）
//
// 0.6.0 接入的三件事：①心跳逐支一檔、復活檢查看本 session 自己的心跳
// ②開場警告三態化（看 ensureWatcher 的實際回傳值，不看舊心跳）③順手帶起桌鈴（deskbell，全機單例）

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { detect } from './detect.mjs';
import { formatUnread } from './format.mjs';
import { loadState, pruneState, saveState } from './state.mjs';
import { FAIL_THRESHOLD, formatWarning, loadHealth, recordFailure, recordSuccess } from './health.mjs';
import {
  readHeartbeats, resolveDataDir, sessionKey, sessionWatcherStatus, watcherStatus, watchersDir,
  SESSION_STALE_MS,
} from './paths.mjs';
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

const dataDir = resolveDataDir();
const HERE = dirname(fileURLToPath(import.meta.url));

function trace(fields) {
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

// ── 行程管理共用件 ────────────────────────────────────────────
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function sweepDeadPidFiles(dir) {
  // 清掃死行程的 pid 檔：行程死了檔不會自己消失，實測堆到 80 個。kill(pid,0)＝只探測不殺
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.pid')) continue;
      const p = Number(readFileSync(join(dir, f), 'utf8').trim());
      if (!pidAlive(p)) { try { unlinkSync(join(dir, f)); } catch {} }
    }
  } catch {}
}

function spawnDetached(script, args) {
  const child = spawn(process.execPath, [join(HERE, script), ...args], {
    detached: true, stdio: 'ignore', windowsHide: true, // windowsHide：防 Windows 閃 console 視窗
  });
  child.unref();
  return child.pid;
}

// ── watcher spawn（逐 session 心跳）─────────────────────────────
// 每個 session 一支，detached；用 pid 檔防同一 session 重複 spawn
// （SessionStart 在 resume／compact 後可能再度觸發）。
// 回傳值是狀態字串，SessionStart 的警告三態靠它說話——改字串要跟 watcherNote 同步：
//   '無socket' | '已在跑' | 'spawn pid=N' | '復活 pid=N' | 'spawn失敗=…'
function ensureWatcher(sessionId) {
  if (!process.env.CLAUDE_CODE_MESSAGING_SOCKET || !process.env.CLAUDE_CODE_MESSAGING_TOKEN) {
    return '無socket'; // headless 等宿主沒有喚醒路，環境層照常
  }
  try {
    const dir = watchersDir(dataDir);
    mkdirSync(dir, { recursive: true });
    sweepDeadPidFiles(dir);
    const pidFile = join(dir, `${sessionKey(sessionId)}.pid`);
    // 看**本 session 自己**的心跳。舊版看共用心跳，別的 session 健康就遮住本 session 的死亡。
    const mine = sessionWatcherStatus(dataDir, sessionId);
    let stale = mine === 'stale';
    try {
      const oldPid = Number(readFileSync(pidFile, 'utf8').trim());
      if (oldPid > 0 && pidAlive(oldPid)) {
        if (mine === 'never') {
          // 行程在、卻從沒寫過心跳：剛 spawn 不到一輪是正常的；pid 檔超過 2 分鐘還沒心跳＝殭屍
          const age = Date.now() - statSync(pidFile).mtimeMs;
          if (age <= SESSION_STALE_MS) return '已在跑';
          stale = true;
        }
        if (!stale) return '已在跑';
        try { process.kill(oldPid, 'SIGTERM'); } catch {} // 卡死屍體，殺掉重生
      }
    } catch {} // 沒 pid 檔或行程已死 → 往下 spawn
    const pid = spawnDetached('watcher.mjs', ['--data', dataDir, '--session', String(sessionId)]);
    writeFileSync(pidFile, String(pid));
    return stale ? `復活 pid=${pid}` : `spawn pid=${pid}`;
  } catch (err) {
    return `spawn失敗=${String(err?.message ?? err)}`;
  }
}

// ── 桌鈴 spawn ──────────────────────────────────────────────────
// 全機單例、不綁通道、不隨 session 退出；活到關機或休眠。
// 每次 hook 順手確認：pid 活著且心跳 2 分鐘內 → 不動；否則帶起來。
// Windows 上 deskbell.mjs 會自己在啟動時退出（暫無實作），這裡照樣嘗試帶起，
// 讓 Windows 版做好之後不用改這邊。
function ensureDeskbell() {
  try {
    const dir = watchersDir(dataDir);
    mkdirSync(dir, { recursive: true });
    const pidFile = join(dataDir, 'deskbell.pid');
    let fresh = false;
    try {
      const h = JSON.parse(readFileSync(join(dataDir, 'deskbell.heartbeat.json'), 'utf8'));
      fresh = Date.now() - Date.parse(h.at) <= SESSION_STALE_MS;
    } catch {}
    try {
      const oldPid = Number(readFileSync(pidFile, 'utf8').trim());
      if (oldPid > 0 && pidAlive(oldPid)) {
        const age = Date.now() - statSync(pidFile).mtimeMs;
        if (fresh || age <= SESSION_STALE_MS) return '已在跑';
        try { process.kill(oldPid, 'SIGTERM'); } catch {}
      }
    } catch {}
    const pid = spawnDetached('deskbell.mjs', ['--data', dataDir]);
    writeFileSync(pidFile, String(pid));
    return `spawn pid=${pid}`;
  } catch (err) {
    return `spawn失敗=${String(err?.message ?? err)}`;
  }
}

/** 開場的通知器狀態說明（三態）。回 null＝什麼都不說。字串前綴與 ensureWatcher 的回傳耦合。 */
function watcherNote(before, w) {
  if (w.startsWith('spawn失敗')) {
    return `【交換區信箱】⚠️ 通知器（watcher）啟動失敗（${w.slice('spawn失敗='.length)}）——訊息落地不會有主動喚醒，只剩開場與工具呼叫後的被動偵測。請用一句話告知使用者。`;
  }
  if ((w.startsWith('復活') || w.startsWith('spawn')) && before === 'stale') {
    const newest = readHeartbeats(dataDir).reduce((m, h) => Math.min(m, h.ageMs), Infinity);
    const mins = Number.isFinite(newest) ? Math.round(newest / 60000) : null;
    return `【交換區信箱】通知器安靜了一段時間${mins != null ? `（上次心跳約 ${mins} 分鐘前）` : ''}，本次開場已自動帶起；這段期間落地的訊息已列在上方未讀。這是正常生命週期，不是故障，不用提醒使用者做任何事。`;
  }
  return null; // 無socket（headless）／已在跑／首次 spawn（never）→ 沉默
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
    const lockFile = join(lockDir, `${sessionKey(sessionId)}-${event}.lock`);
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
      const b = ensureDeskbell();
      // 有裝但讀不到交換區：記一次失敗，達門檻就在開場講出來
      const h = recordFailure(dataDir, result.error);
      trace([`watcher=${w}`, `deskbell=${b}`]);
      trace([`偵測失敗=${result.error}`, `連續失敗=${h.consecutiveFailures}`]);
      const warning = formatWarning(h);
      if (warning) emit(warning);
      process.exit(0);
    }
    recordSuccess(dataDir);
    const before = watcherStatus(dataDir); // 先量、再動手——三態說明要知道「之前是不是安靜了一段」
    const w = ensureWatcher(sessionId);
    const b = ensureDeskbell();

    // 已讀回寫：read.md 變了才鏡射到交換區彙總檔，沒變零成本
    try {
      const { syncReadback } = await import('./readback.mjs');
      syncReadback({ dataDir });
    } catch (err) {
      trace([`readback失敗=${String(err?.message ?? err)}`]);
    }

    let context = formatUnread(result, { mode: 'session', limit: 8 });
    const note = watcherNote(before, w);
    if (note) context = context ? context + '\n\n' + note : note;

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
      `before=${before}`,
      `deskbell=${b}`,
    ]);
    if (context) emit(context);
    process.exit(0);
  }

  // ── PostToolUse：搭便車偵測 ──────────────────────────────────
  // 職責是「watcher 死掉的安全網」：只報新落地的，沒有新東西就一個字都不輸出。
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

  // watcher 自我復活（改看本 session 自己的心跳）：原本只有 SessionStart 會 spawn，
  // 長壽 session 的 watcher 死了就永遠沒人管。這裡在每次（節流後的）搭便車掃描順手檢查，
  // 不健康就帶起來——「每個開著的對話都有一支活的 watcher」從此成立，且不被別的對話遮蔽。
  if (sessionWatcherStatus(dataDir, sessionId) !== 'alive') {
    trace([`watcher復活檢查=${ensureWatcher(sessionId)}`]);
  }
  const b = ensureDeskbell();
  if (b !== '已在跑') trace([`deskbell=${b}`]);

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
