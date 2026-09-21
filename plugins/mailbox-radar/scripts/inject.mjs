#!/usr/bin/env node
// mailbox-radar · 注入器
//
// 被 hooks.json 以 shell 形式呼叫（0.5.1 起）：
//   sh noderun.sh inject.mjs --event SessionStart|PostToolUse|UserPromptSubmit
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

import { countsAsActivity, recordActivity } from './attention.mjs';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { detect } from './detect.mjs';
import { formatUnread } from './format.mjs';
import { loadState, pruneState, saveState } from './state.mjs';
import { FAIL_THRESHOLD, formatWarning, loadHealth, recordFailure, recordSuccess } from './health.mjs';
import { SESSION_STALE_MS, heartbeatFromOtherVersion, heartbeatPath, readHeartbeats, resolveDataDir, sessionKey, sessionWatcherStatus, watcherStatus, watchersDir } from './paths.mjs';
import { configPath, contactsPath, ensureUserData } from './userdata.mjs';
import { loadContacts, migrateWhitelist } from './contacts.mjs';

// 搭便車注入的掃描節流：同一個 session 內，最短 SCAN_COOLDOWN_MS 才會再掃一次交換區。
// 掃一次只要 0.3 毫秒、零 token，所以節流不是為了省成本，是為了不在密集工具呼叫時
// 對 Drive 掛載連發 readdir。10 秒的上限對「30 分鐘太久」這個需求還有很大餘裕。
const SCAN_COOLDOWN_MS = 10_000;

// 一次最多具體列幾筆，其餘收成「另有 N 筆較舊的未列出」。
const SESSION_LIMIT = 8;
const INLINE_LIMIT = 5;

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
    `請引導使用者建立 ${configPath()}，裡面需要兩個欄位：`,
    '  名字：使用者在交換區的代稱，要跟他的收件匣資料夾後綴一致',
    '  交換區：交換區資料夾在這臺機器上的絕對路徑',
    '',
    `範本在 ${template}，可以複製過去再填。`,
    '名字要問使用者；交換區路徑可以自己找，通常在 Google Drive 掛載底下的 _交換區。',
    '設定完成後要開一個新對話才會生效。成員名單（通訊錄）不用現在填：新對話開場會提示，',
    '到時對 Claude 說「同步通訊錄」就會從 Drive 分享名單帶入。',
    '如果使用者現在不想處理，回一句知道了就好，不要打斷他手上的事。',
  ].join('\n');
}

/**
 * 「設定好了、但通訊錄是空的」的開場提示。
 *
 * 通訊錄空著時雷達照樣偵測未讀（偵測只看檔名），但白名單閘門會把每一封都判成異常、
 * 一律不自動回覆，而且寄信前查不到對象。這是實際會咬人的狀態，所以每次開場講一次，
 * 直到名單有人為止；PostToolUse 不講（同 firstRunGuidance 的理由）。
 */
function contactsGuidance() {
  return [
    `【交換區信箱】通訊錄是空的（${contactsPath()}），所以收進來的訊息都會被當成名單外、不自動回覆，寄信前也查不到對象。`,
    '請建議使用者對你說「同步通訊錄」：team-mailbox skill 會用 Drive 工具讀交換區的分享名單，把成員的 email、代稱、姓名帶進通訊錄。',
    '沒有 Drive 工具的話說「通訊錄加人」手動加，一次一人（email 與代稱）。',
    '如果使用者現在不想處理，回一句知道了就好，不要打斷他手上的事。',
  ].join('\n');
}

/**
 * 未讀清單後面附的記帳指示。
 *
 * 為什麼要在每次注入時講一次，而不是只寫在 skill 裡：未讀數的語意是「人還沒處理」。
 * 要維持這個語意，記帳必須發生在人真的處理過之後，而那個時機只有當下這個對話知道。
 * 雷達自己記＝用機器行為冒充人的行為；只寫在 skill 裡＝使用者沒喊「查信箱」時沒人記。
 * 所以指示要跟著未讀清單一起送到，就在該記帳的那個對話裡。
 *
 * 0.5.x 沒有這一步，記帳只是 skill 裡一句散文。實測結果是它幾乎不發生：2026-09-10
 * 查到一臺機器的已讀帳停在 07-21，之後兩個月的 45 封一筆都沒記，雷達因此在每個對話
 * 都虛報 58 封未讀，真實數字是 6 封。使用者的說法是「我確實有看過也確實已讀了，
 * 但是它還是報未讀」——問題在記帳不可靠，不在記帳時機。
 */
function markReadHint(exchanges = []) {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  const script = root ? join(root, 'scripts', 'markread.mjs') : '<plugin>/scripts/markread.mjs';
  const lines = [
    '【記帳】上面這些**還沒**被標記為已讀——你把它們列出來不算，要使用者真的看過或處理過才算。',
    '使用者在這一輪確實處理了其中某幾封之後（讀完了、回覆了、決定不處理了都算），跑：',
    `  node "${script}" --note "<處理結果>" <檔名> [<檔名>...]`,
  ];
  // 訊息前面的【標籤】是顯示名稱，記帳要帶的 --exchange 是資料夾名稱，兩者可能不同（預設交換區取了名字時尤其如此），
  // 所以逐區列出對照，不讓模型猜。
  const live = exchanges.filter((x) => x.ok);
  const labeled = live.filter((x) => x.id || x.label);
  if (labeled.length > 0) {
    const map = live.map((x) => {
      const tag = x.label ?? x.id;
      if (!x.id) return tag ? `【${tag}】＝預設交換區，記帳不帶 --exchange` : '沒有標籤的＝預設交換區，記帳不帶 --exchange';
      return `【${tag}】＝ --exchange ${x.id}`;
    });
    lines.push(`標籤對照：${map.join('；')}。不同交換區的分開跑。帶錯或漏帶會記到別區的帳上，那封就會一直算未讀。`);
  }
  lines.push(
    '看到回報的 added 有值才算記成功。沒記的話下次開場還會再報一次，那是正確行為。',
    '使用者只是聽你講了一句「有幾封未讀」就繼續做別的事 → 不要記帳。',
  );
  return lines.join('\n');
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
//   '無socket' | '已在跑' | 'spawn pid=N' | '復活 pid=N' | '換版 pid=N' | 'spawn失敗=…'
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
        // 活著而且心跳新鮮，但心跳是別的版本的程式寫的：plugin 更新過了，這支還在跑舊版。
        // 舊版可能不認得新功能（實測：不認得新掛的交換區，即時通知整條死掉而且不報錯），換掉。
        const otherVersion = mine === 'alive' && heartbeatFromOtherVersion(heartbeatPath(dataDir, sessionId), join(HERE, 'watcher.mjs'));
        if (!stale && !otherVersion) return '已在跑';
        try { process.kill(oldPid, 'SIGTERM'); } catch {} // 卡死屍體或舊版，殺掉重生
        if (otherVersion) {
          // 舊心跳先刪：Windows 上的 kill 不給舊行程收尾的機會，心跳檔會留著，
          // 新行程寫出第一筆心跳之前，下一次檢查會再把它當成舊版又殺一次。
          try { unlinkSync(heartbeatPath(dataDir, sessionId)); } catch {}
          const pid = spawnDetached('watcher.mjs', ['--data', dataDir, '--session', String(sessionId)]);
          writeFileSync(pidFile, String(pid));
          return `換版 pid=${pid}`;
        }
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
        // 同 watcher：心跳新鮮但是別的版本寫的＝plugin 更新後還在跑舊版，換掉
        const otherVersion = fresh && heartbeatFromOtherVersion(join(dataDir, 'deskbell.heartbeat.json'), join(HERE, 'deskbell.mjs'));
        if ((fresh || age <= SESSION_STALE_MS) && !otherVersion) return '已在跑';
        try { process.kill(oldPid, 'SIGTERM'); } catch {}
        if (otherVersion) { try { unlinkSync(join(dataDir, 'deskbell.heartbeat.json')); } catch {} }
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

  // 記一筆「人動了這個對話」（0.7.6）：watcher 靠它決定新訊息該叫醒哪個對話，規則見 attention.mjs。
  // UserPromptSubmit 只做這件事：不掃交換區、不輸出，使用者每次送訊息都會經過，必須輕。
  if (countsAsActivity(event, payload)) recordActivity(dataDir, sessionId, { cwd: payload.cwd, kind: event, at: now });
  if (event === 'UserPromptSubmit') process.exit(0);

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
    // 0.5.x config.md 的「白名單：」行 → 通訊錄.md（0.6.0 task 3）。同樣只在這裡、冪等。
    try {
      const mw = migrateWhitelist();
      if (mw.migrated > 0) trace([`白名單已轉入通訊錄=${mw.migrated}人`]);
    } catch (err) {
      trace([`白名單轉入失敗=${String(err?.message ?? err)}`]);
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

    // ⚠️ 這裡刻意**不**自動記帳。
    //
    // 未讀數的意思是「人還沒處理」，不是「機器還沒報過」。開場把訊息列出來只證明
    // 雷達掃到了，不證明人看了——很多時候使用者正在忙別的事，那一行根本沒被讀進眼睛。
    // 在這裡記帳等於用機器行為冒充人的行為，訊息會從清單裡消失而沒有人看過它。
    //
    // 0.6.0 開發中一度做成「報過就算已讀」，使用者當場推翻：他要的是人真的看過才算。
    // 他遇到的問題不是「數字降不下來」，是「我確實看過也處理了，它還是報未讀」——
    // 那是記帳機制不可靠，不是記帳時機太晚。修法在 markread.mjs（把散文指示換成腳本），
    // 不是把記帳提前到人還沒看的時候。
    //
    // 真正該記帳的時機有兩個，都在人實際處理過之後：
    //   1. 使用者看完這批未讀、你在同一輪替他處理掉 → 照下面注入的指示呼叫 markread.mjs
    //   2. 走 team-mailbox skill 的「查信箱」流程 → 該 skill 第 4 步呼叫 markread.mjs

    // 已讀回寫：各交換區的 read.md 變了才鏡射到該區的彙總檔，沒變零成本
    try {
      const { syncReadback } = await import('./readback.mjs');
      for (const x of result.exchanges ?? [{ id: null, ok: true }]) {
        if (!x.ok) continue;
        try {
          syncReadback({ dataDir, configPath: x.configPath, ledgerPath: x.ledgerPath, exchangeId: x.id });
        } catch (err) {
          trace([`readback失敗${x.id ? `（${x.id}）` : ''}=${String(err?.message ?? err)}`]);
        }
      }
    } catch (err) {
      trace([`readback失敗=${String(err?.message ?? err)}`]);
    }

    let context = formatUnread(result, { mode: 'session', limit: SESSION_LIMIT });
    if (context) context += '\n\n' + markReadHint(result.exchanges ?? []);
    const note = watcherNote(before, w);
    if (note) context = context ? context + '\n\n' + note : note;
    // 額外交換區讀不到：整體照常運作，但要讓人知道那一區的新訊息現在偵測不到
    const broken = (result.exchanges ?? []).slice(1).filter((x) => !x.ok);
    if (broken.length > 0) {
      const b = [
        '【交換區信箱】⚠️ 有額外交換區讀不到，那裡的新訊息目前偵測不到。請用一句話告知使用者：',
        ...broken.map((x) => `- 交換區「${x.id}」：${x.error}`),
      ].join('\n');
      context = context ? context + '\n\n' + b : b;
      trace([`額外交換區讀不到=${broken.map((x) => x.id).join(',')}`]);
    }
    // 分類器上次整個失敗過 → 開場講一次（成功一次就會自己清掉）
    try {
      const h = JSON.parse(readFileSync(join(dataDir, 'classifier-health.json'), 'utf8'));
      const c = [
        `【交換區信箱】⚠️ 自動代答的分類器上次整個跑不起來（${String(h.at).slice(0, 16).replace('T', ' ')} UTC）。在修好之前，收到的每一封都會當成「先問過本人才處理」，不會自動回。請用一句話告知使用者。`,
        h.authLike
          ? '看起來是終端機版 Claude 的登入過期了（桌面版登入不算）。請使用者開終端機跑 claude，進去輸入 /login 重新登入一次。'
          : `原因：${String(h.detail ?? '').slice(0, 300)}`,
      ].join('\n');
      context = context ? context + '\n\n' + c : c;
      trace(['分類器不可用=已提示']);
    } catch {}
    // 通訊錄空的 → 提示一次（讀取失敗也當空：提示比靜默安全）
    let rosterEmpty = false;
    try { rosterEmpty = loadContacts().filter((c) => c.status === 'active').length === 0; } catch { rosterEmpty = true; }
    if (rosterEmpty) {
      const g = contactsGuidance();
      context = context ? context + '\n\n' + g : g;
    }

    // 開場那一刻看得到的所有檔案都算「已告知」的基準，之後搭便車只報這個 session 進行中新落地的。
    // 用 arrivals 不用 unread：收件匣交給其他系統追蹤時，收件匣的舊檔不在 unread 裡、開場也沒列，
    // 但它們也不是「新落地」。不放進基準的話，第一次搭便車就會把整個收件匣歷史當成新的倒出來。
    // 用 key 不用檔名：兩個交換區可能有同名檔。exchanges 記下這一刻建過基準的交換區，
    // 對話開著時才新掛上去的交換區，搭便車會先替它建基準，而不是整批報出來。
    pruneState(dataDir, now);
    saveState(dataDir, sessionId, {
      announced: new Set((result.arrivals ?? result.unread).map((u) => u.key ?? u.file)),
      exchanges: (result.exchanges ?? [{ id: null, ok: true }]).filter((x) => x.ok).map((x) => x.id ?? ''),
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
  if (sessionWatcherStatus(dataDir, sessionId) !== 'alive'
    || heartbeatFromOtherVersion(heartbeatPath(dataDir, sessionId), join(HERE, 'watcher.mjs'))) {
    trace([`watcher復活檢查=${ensureWatcher(sessionId)}`]);
  }
  const b = ensureDeskbell();
  if (b !== '已在跑') trace([`deskbell=${b}`]);

  const pool = result.arrivals ?? result.unread;
  const keyOf = (u) => u.key ?? u.file; // 兩個交換區可能有同名檔，一律用 key
  const okTags = (result.exchanges ?? [{ id: null, ok: true }]).filter((x) => x.ok).map((x) => x.id ?? '');

  // 沒有基準（這個 session 的狀態檔不存在，例如閒置超過保留天數被清掉）：只建基準、不報。
  // 跟 watcher 第一輪同一個原則——舊帳歸開場注入，搭便車只管 session 進行中新落地的。
  // 收件匣交給其他系統追蹤時這條特別重要：收件匣的舊檔永遠不會進已讀帳，沒基準就會整批被當成新落地。
  if (!state.lastScanAt) {
    for (const u of pool) state.announced.add(keyOf(u));
    state.exchanges = okTags;
    state.lastScanAt = now;
    saveState(dataDir, sessionId, state);
    trace([`session=${sessionId}`, `tool=${payload.tool_name ?? '-'}`, `建基準=${pool.length}`]);
    process.exit(0);
  }

  // 這個 session 第一次看到的交換區（對話開著時才新掛上去的，或開場時雷達還是不認得多交換區的舊版）。
  // 只替「不追蹤」的檔建基準：收件匣交給其他系統追蹤時，那些檔永遠不進已讀帳，不建基準會整批倒出來。
  // 雷達自己追的檔會出現在 pool 裡，就代表它不在已讀帳＝還沒處理的信，不是歷史（歷史早就在已讀帳裡、
  // 根本進不了 pool）。這個 session 的開場注入沒涵蓋過這一區，這裡不報就永遠沒人報。
  // 0.7.0 把它們一起放進基準，新掛的交換區裡等著的信就被整批吞掉、從來沒通知過任何人。
  // 舊狀態檔沒有 exchanges 欄位，代表只有預設交換區建過基準。
  const known = new Set(state.exchanges ?? ['']);
  const newTags = okTags.filter((t) => !known.has(t));
  if (newTags.length > 0) {
    const newSet = new Set(newTags);
    for (const u of pool) if (newSet.has(u.exchangeId ?? '') && u.tracked === false) state.announced.add(keyOf(u));
    state.exchanges = [...known, ...newTags];
    trace([`session=${sessionId}`, `新掛交換區建基準=${newTags.join(',')}`]);
  }

  const fresh = pool.filter((u) => !state.announced.has(keyOf(u)));
  state.lastScanAt = now;
  for (const u of fresh) state.announced.add(keyOf(u));
  saveState(dataDir, sessionId, state);

  if (fresh.length === 0) {
    trace([`session=${sessionId}`, `tool=${payload.tool_name ?? '-'}`, `未讀=${result.unreadCount}`, '新落地=0', `耗時=${result.elapsedMs.toFixed(2)}ms`]);
    process.exit(0);
  }

  // 同 SessionStart：不自動記帳。搭便車報出來的訊息更不可能「已經被人看過」——
  // 使用者當下正在做別的事，這行字是插進來的。
  const freshResult = { ...result, unread: fresh, unreadCount: fresh.length };
  const context = formatUnread(freshResult, { mode: 'inline', limit: INLINE_LIMIT });

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
