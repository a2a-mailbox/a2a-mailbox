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
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SKILL_DIR = join(homedir(), '.claude', 'skills', 'team-mailbox');
const CONFIG_PATH = join(SKILL_DIR, 'config.md');
const READ_LEDGER_PATH = join(SKILL_DIR, 'read.md');
const BOARD_DIR = '公告板';

// 交換區規約 v0.4 的檔名 schema 用的前綴
const KNOWN_TYPES = new Set(['訊息', '請求', '回執', '附件', '公告', '安裝包']);
const COUNTED_EXT = new Set(['.md', '.html']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 讀 team-mailbox 的 config.md 取「名字」與「交換區」絕對路徑（不要另外寫死路徑）。 */
export function readConfig(configPath = CONFIG_PATH) {
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
  return { name, exchange };
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
export function readLedger(ledgerPath = READ_LEDGER_PATH) {
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

/** 主流程：回傳未讀清單（只有 metadata）＋掃描帳。 */
export function detect(opts = {}) {
  const started = process.hrtime.bigint();
  const result = {
    ok: false,
    name: null,
    unreadCount: 0,
    unread: [],
    scanned: {},
    ledgerCount: 0,
    elapsedMs: 0,
    error: null,
    // 失敗分兩種：'config'＝根本沒裝 team-mailbox（沒有 config.md），該靜默；
    // 'scan'＝有裝但讀不到交換區（EPERM、掛載掉了…），該讓人看見
    errorKind: null,
  };

  let phase = 'config';
  try {
    // 環境變數覆寫只給測試與除錯用（正式路徑是 ~/.claude/skills/team-mailbox/）
    const { name, exchange } = readConfig(
      opts.configPath || process.env.MAILBOX_RADAR_CONFIG || CONFIG_PATH,
    );
    result.name = name;
    phase = 'scan';

    const ledger = readLedger(
      opts.ledgerPath || process.env.MAILBOX_RADAR_LEDGER || READ_LEDGER_PATH,
    );
    result.ledgerCount = ledger.size;

    const places = [
      { where: `收件匣-${name}`, channel: 'inbox' },
      { where: BOARD_DIR, channel: 'board' },
    ];

    for (const place of places) {
      const { files, missing } = listFiles(join(exchange, place.where));
      result.scanned[place.channel] = { where: place.where, total: files.length, missing };
      for (const file of files) {
        if (ledger.has(file)) continue;
        result.unread.push({ file, where: place.where, channel: place.channel, ...parseFilename(file) });
      }
    }

    // 新的排前面（沒有日期的排最後）
    result.unread.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
    result.unreadCount = result.unread.length;
    result.ok = true;
  } catch (err) {
    result.error = String(err?.message ?? err);
    result.errorKind = phase === 'config' ? 'config' : 'scan';
  }

  result.elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  return result;
}

// 直接執行時才印（被 import 時不印）。
// 比對用 pathToFileURL 而不是字串拼 `file://`——本機路徑含空白，拼出來的字串跟
// import.meta.url 的百分號編碼對不起來，會靜默不印。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = detect();
  process.stdout.write(JSON.stringify(out, null, process.argv.includes('--pretty') ? 2 : 0) + '\n');
  process.exit(0);
}
