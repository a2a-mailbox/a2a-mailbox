#!/usr/bin/env node
// team-mailbox-radar · 偵測器
//
// 做一件事：算出「交換區裡有哪些檔案，是本機已讀帳還沒記過的」。
//
// 三條硬紀律（來自 Phase 1 子 Plan 的驗收條件，改動前先看清楚）：
//   1. 只掃兩處：收件匣-<自己>/ ＋ 公告板/（交換區規約「掃描慣例」明文，不全區掃描）
//   2. 判斷有無新檔一律用 readdir 做集合差集，**不准**用資料夾 mtime 或 stat/nlink——
//      2026-08-19 實測：新檔到達期間資料夾 mtime 全程未變
//   3. 只從檔名取 metadata，**不讀檔案內容**——交換區 40 個檔裡 34 個在本機是 dataless，
//      讀一個 2.7KB 的檔要一次網路往返、實測 1.338 秒
//
// 用法：
//   node detect.mjs            → 印出 JSON 到 stdout
//   node detect.mjs --pretty   → 縮排版 JSON（人看的）
// 也可以被別的腳本 import：`import { detect } from './detect.mjs'`

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { configPath as defaultConfigPath, ledgerPath as defaultLedgerPath, listExchanges } from './userdata.mjs';

const BOARD_DIR = '公告板';

// 交換區規約 v0.4 的檔名 schema 用的前綴
const KNOWN_TYPES = new Set(['訊息', '請求', '回執', '附件', '公告', '安裝包']);
const COUNTED_EXT = new Set(['.md', '.html']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 讀 team-mailbox 的 config.md 取「名字」與「交換區」絕對路徑（不要另外寫死路徑）。 */
export function readConfig(configPath = defaultConfigPath()) {
  const raw = readFileSync(configPath, 'utf8');
  const pick = (label) => {
    const m = raw.match(new RegExp(`^${label}\\s*[：:]\\s*(.+)$`, 'm'));
    return m ? m[1].trim() : null;
  };
  const name = pick('名字');
  const exchange = pick('交換區');
  if (!name || !exchange) {
    throw new Error(`config.md 缺欄位（名字=${name ?? '無'}, 交換區=${exchange ?? '無'}）`);
  }
  // 選填：收件匣是不是另有系統在追（例如使用者自己的每日掃描把訊息分流進待辦清單）。
  // 是的話，雷達對收件匣只做「剛到了」的即時通知、不記舊帳。原因是兩個互不溝通的系統
  // 各記各的「處理過沒」，雷達那本永遠不會知道另一邊處理掉什麼，開場未讀數就會一路漂高。
  // 沒寫、或寫別的值＝雷達自己追（通用版預設，行為與改動前相同）。
  const tracking = pick('收件匣追蹤');
  const inboxTracking = tracking && /其他|外部|external/i.test(tracking) ? 'external' : 'radar';
  // 選填：這一區在報告裡怎麼稱呼。預設交換區原本沒有名字，開場只講「你有 N 筆」；同時掛好幾個一對一的人
  // 分不出哪一區是誰，所以讓每一區都能取名。額外交換區沒寫就用資料夾名稱（跟 0.7.x 一樣）。
  // 這只是顯示用的標籤：記帳與認領仍然用資料夾名稱（--exchange），已有的狀態檔不受影響。
  const label = pick('交換區名稱');
  return { name, exchange, inboxTracking, label };
}

/**
 * 讀已讀帳，回傳「檔名集合」。
 * read.md 是人也在看的 markdown 條列，一行一筆，形如
 *   `- 訊息_甲→乙_某主題_2026-07-27.md（2026-07-28 已回執結案）`
 * 只認**每行開頭那一個檔名**，不撈註記正文裡提到的檔名。
 * 理由：註記常會引用別的檔（「附件_X.md 可直接轉給對方」），寬鬆比對會把它算成已讀，
 * 而算錯的方向是「靜默隱藏一封沒人看過的訊息」——比多報一筆嚴重得多。
 * 檔案不存在（同事剛裝好、還沒讀過任何訊息）視為空帳，不是錯誤。
 */
export function readLedger(ledgerPath = defaultLedgerPath()) {
  let raw;
  try {
    raw = readFileSync(ledgerPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return new Set();
    throw err;
  }
  const seen = new Set();
  for (const line of raw.split(/\r?\n/)) {
    // 去掉條列符號／編號，再取到第一個註記起始字元或空白為止
    const body = line.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, '').trim();
    const token = body.split(/[（(\s]/)[0];
    // team-mailbox skill 寫入的條目可能帶資料夾前綴（公告板/…、收件匣-X/…），
    // 掃描端用純檔名比對——取 basename 讓兩種格式都認得（0.4.3，試點使用者回報：
    // 前綴版比不到會讓歷史已讀在裝機時全部詐屍成未讀）。分隔符正反斜線都認（Windows）。
    const name = token.split(/[\\/]/).pop();
    if (/\.(?:md|html)$/i.test(name)) seen.add(name);
  }
  return seen;
}

/** 從檔名（只有檔名）解析 metadata。解析不出來也一定回傳可用的物件。 */
export function parseFilename(file) {
  const dot = file.lastIndexOf('.');
  const ext = dot > 0 ? file.slice(dot).toLowerCase() : '';
  const stem = dot > 0 ? file.slice(0, dot) : file;
  const seg = stem.split('_');

  let date = null;
  let end = seg.length;
  if (seg.length > 1 && DATE_RE.test(seg[seg.length - 1])) {
    date = seg[seg.length - 1];
    end = seg.length - 1;
  }

  const type = KNOWN_TYPES.has(seg[0]) ? seg[0] : '其他';
  const joinMid = (from, to) => seg.slice(from, to).join('・') || null;

  let from = null;
  let to = null;
  let subject = null;

  if (type === '訊息' || type === '請求') {
    // 訊息_<寄件人>→<收件人>_<主題slug>_<日期>
    const pair = seg[1] ?? '';
    if (pair.includes('→')) {
      [from, to] = pair.split('→').map((s) => s.trim());
      subject = joinMid(2, end);
    } else {
      subject = joinMid(1, end);
    }
  } else if (type === '回執') {
    // 回執_<同主題slug>_<回覆人>_<日期>：回覆人固定在日期前一格
    if (end - 1 >= 1) {
      from = seg[end - 1];
      subject = joinMid(1, end - 1);
    } else {
      subject = joinMid(1, end);
    }
  } else {
    // 附件／公告／安裝包／其他：檔名不帶人，主題＝中間全部
    subject = joinMid(type === '其他' ? 0 : 1, end);
  }

  return { type, from, to, subject, date, ext };
}

function listFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return { files: [], missing: true };
    throw err;
  }
  const files = entries
    // 「已讀-*」是各人自產的已讀彙總檔（task 11），是狀態不是訊息，不進未讀清單
    .filter((e) => e.isFile() && !e.name.startsWith('.') && !e.name.startsWith('已讀-'))
    .map((e) => e.name)
    .filter((n) => COUNTED_EXT.has(n.slice(n.lastIndexOf('.')).toLowerCase()));
  return { files, missing: false };
}

/**
 * 掃一個交換區，回傳這個交換區自己的結果，由 detect() 彙總。
 *
 * 每封訊息帶 exchangeId（預設交換區是 null）與 key。key 是跨交換區唯一的識別：
 * 「已告知」「響過了」這類集合一律用它，因為兩個交換區可能有同名檔，用純檔名會互相蓋掉。
 * 預設交換區的 key 就是檔名本身，所以只掛一個交換區的機器，既有狀態檔完全不受影響。
 */
function scanOne({ id = null, configPath, ledgerPath }) {
  const r = {
    id,
    ok: false,
    name: null,
    exchangePath: null,
    inboxTracking: null,
    configPath,
    ledgerPath,
    unreadCount: 0,
    untrackedCount: 0,
    arrivals: [],
    scanned: {},
    ledgerCount: 0,
    label: null,
    error: null,
    errorKind: null,
  };
  let phase = 'config';
  try {
    const { name, exchange, inboxTracking, label } = readConfig(configPath);
    r.name = name;
    r.exchangePath = exchange;
    r.inboxTracking = inboxTracking;
    r.label = label ?? id; // 顯示用；預設交換區沒取名就是 null
    phase = 'scan';

    const ledger = readLedger(ledgerPath);
    r.ledgerCount = ledger.size;

    const places = [
      { where: `收件匣-${name}`, channel: 'inbox' },
      { where: BOARD_DIR, channel: 'board' },
    ];
    for (const place of places) {
      const { files, missing } = listFiles(join(exchange, place.where));
      r.scanned[place.channel] = { where: place.where, total: files.length, missing };
      const tracked = !(place.channel === 'inbox' && inboxTracking === 'external');
      for (const file of files) {
        if (ledger.has(file)) continue;
        r.arrivals.push({
          file,
          where: place.where,
          channel: place.channel,
          tracked,
          exchangeId: id,
          exchangeLabel: label ?? id,
          key: id ? `${id}/${file}` : file,
          ...parseFilename(file),
        });
      }
    }
    r.unreadCount = r.arrivals.filter((u) => u.tracked).length;
    r.untrackedCount = r.arrivals.length - r.unreadCount;
    r.ok = true;
  } catch (err) {
    r.error = String(err?.message ?? err);
    r.errorKind = phase === 'config' ? 'config' : 'scan';
  }
  return r;
}

/**
 * 主流程：回傳未讀清單（只有 metadata）＋掃描帳。
 *
 * 掛了多個交換區時逐區掃描再彙總。整體的 ok／error／name／scanned 沿用預設交換區的：
 * 預設交換區沒設定＝還沒裝好；而額外交換區讀不到，不該讓整個雷達停擺。
 * 各區自己的狀態放在 exchanges 陣列，由呼叫端決定怎麼告知。
 *
 * 給了 opts.configPath 或 MAILBOX_RADAR_CONFIG（測試與除錯用）時只掃那一個，行為與 0.6.0 相同。
 */
export function detect(opts = {}) {
  const started = process.hrtime.bigint();
  const ledgerOverride = opts.ledgerPath || process.env.MAILBOX_RADAR_LEDGER;
  const configOverride = opts.configPath || process.env.MAILBOX_RADAR_CONFIG;
  const targets = configOverride
    ? [{ id: null, configPath: configOverride, ledgerPath: ledgerOverride || defaultLedgerPath() }]
    : listExchanges().map((x) => (x.id === null && ledgerOverride ? { ...x, ledgerPath: ledgerOverride } : x));
  const parts = targets.map(scanOne);
  const root = parts[0];

  const result = {
    ok: root.ok,
    name: root.name,
    // 預設交換區的顯示名稱（config 的「交換區名稱」），沒取就 null
    label: root.label ?? null,
    // 收件匣由誰追蹤（預設交換區的設定）：'radar'＝雷達自己記帳；'external'＝另有系統在追，雷達對收件匣只做即時通知
    inboxTracking: root.inboxTracking,
    // unread＝要算進未讀數、要在開場列出來的（追蹤中的那些），跨所有交換區。unreadCount 永遠等於它的長度。
    unreadCount: 0,
    unread: [],
    // arrivals＝所有不在已讀帳的檔，每項帶 tracked、exchangeId、key。給「新落地偵測」用（watcher、搭便車、桌鈴）：
    // 不追蹤的收件匣檔雖然不算未讀，剛落地時一樣要通知。只掛一個交換區且沒有外部追蹤時，它與 unread 是同一批。
    arrivals: [],
    untrackedCount: 0,
    scanned: root.scanned,
    ledgerCount: root.ledgerCount,
    elapsedMs: 0,
    error: root.error,
    // 失敗分兩種：'config'＝根本沒裝 team-mailbox（沒有 config.md），該靜默；
    // 'scan'＝有裝但讀不到交換區（EPERM、掛載掉了…），該讓人看見
    errorKind: root.errorKind,
    // 各交換區自己的狀態（不含訊息清單）。第一個永遠是預設交換區。
    exchanges: parts.map(({ arrivals, ...rest }) => rest),
  };

  if (root.ok) {
    for (const p of parts) if (p.ok) result.arrivals.push(...p.arrivals);
    // 新的排前面（沒有日期的排最後）。filter 保留順序，所以 unread 跟著排好。
    result.arrivals.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
    result.unread = result.arrivals.filter((u) => u.tracked);
    result.unreadCount = result.unread.length;
    result.untrackedCount = result.arrivals.length - result.unread.length;
  }

  result.elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  return result;
}

/**
 * 一個訊息檔屬於哪個交換區。找不到回 null。
 *
 * 給閘門與認領鎖用：它們拿到的是訊息檔路徑，要知道該查哪一份通訊錄、票要記在哪個名下。
 * 比對前兩邊路徑都正規化，Windows 不分大小寫。多個交換區路徑互相包含時取最長的那個；
 * 「_交換區」與「_交換區-雙機」這種前綴相同的兄弟資料夾不會互吃，因為要求後面緊接路徑分隔符。
 * @param {string} filePath
 * @param {Array} [exchanges] 測試用；預設讀 listExchanges() 並解析各自的交換區路徑
 */
export function exchangeForPath(filePath, exchanges) {
  const list = exchanges ?? listExchanges().map((x) => {
    try { return { ...x, exchangePath: readConfig(x.configPath).exchange }; } catch { return null; }
  }).filter(Boolean);
  const norm = (p) => {
    let s = resolve(String(p)).replace(/[\\/]+$/, '');
    if (process.platform === 'win32') s = s.toLowerCase();
    return s;
  };
  const target = norm(filePath);
  let best = null;
  let bestLen = -1;
  for (const x of list) {
    if (!x.exchangePath) continue;
    const root = norm(x.exchangePath);
    if ((target === root || target.startsWith(root + sep)) && root.length > bestLen) {
      best = x;
      bestLen = root.length;
    }
  }
  return best;
}

// 直接執行時才印（被 import 時不印）。
// 比對用 pathToFileURL 而不是字串拼 `file://`——本機路徑含空白，拼出來的字串跟
// import.meta.url 的百分號編碼對不起來，會靜默不印。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = detect();
  process.stdout.write(JSON.stringify(out, null, process.argv.includes('--pretty') ? 2 : 0) + '\n');
  process.exit(0);
}
