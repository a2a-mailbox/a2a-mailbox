#!/usr/bin/env node
// team-mailbox-radar · 白名單閘門（Phase 3 task 8）
//
// 身分驗證依據是 Drive 檔案 owner（誰真正寫了這個檔），不是 frontmatter 的 from——
// from 任何人都能亂寫；兩者不一致本身就是異常訊號。
//
// owner 要查 Drive API，而 API 憑證只在 session 的 MCP connector 手上，所以閘門分兩段、
// 判斷邏輯全部留在本檔（可測試），session 的 Claude 只負責搬 owner 這個事實：
//   第一段  node gate.mjs <訊息檔路徑>
//           → 印 {stage:'need-owner', itemId, claimedFrom, …}，拿 itemId 去問 MCP
//   第二段  node gate.mjs <訊息檔路徑> --owner <MCP 回的 email>
//           → 印最終判定 {stage:'verdict', pass, anomaly, tierFloor, …}
//
// 名單外／異常＝tier 2（照樣收信、照樣告訴使用者，只是不自動回）。

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

import { configPath as defaultConfigPath } from './userdata.mjs';

// 白名單住本機（放交換區的話，能寫那個資料夾的人就能把自己加進去，等於沒有名單）。
// 來源＝使用者資料目錄的 config.md（使用者自填），一行一人：
//   白名單：<Google email> <名字>
// 不放在 plugin 目錄裡：那是版本化快取，更新就被覆蓋。

export function loadWhitelist(configPath = process.env.MAILBOX_RADAR_CONFIG || defaultConfigPath()) {
  const list = {};
  try {
    const raw = readFileSync(configPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^白名單\s*[：:]\s*(\S+)\s+(.+)$/);
      if (m) list[m[1].trim()] = m[2].trim();
    }
  } catch {}
  return list;
}

export const WHITELIST = loadWhitelist();

/**
 * 取 Drive 的 item id（本機零網路）。拿不到回 null——呼叫端改走 by-path 反查。
 * macOS：Drive for Desktop 把 id 放在掛載檔的 xattr 上。
 * Windows：沒有 xattr 等價通道（metadata 在 DriveFS 的私有 SQLite，非公開介面），
 * 直接回 null、走反查退化路。
 */
export function driveItemId(path) {
  if (process.platform === 'win32') return null;
  try {
    return execFileSync('/usr/bin/xattr', ['-p', 'com.google.drivefs.item-id#S', path],
      { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

/** 從檔名與 frontmatter 撈宣稱的寄件人（兩處都是可偽造的宣稱，只當對帳材料）。 */
export function claimedSender(path) {
  let fmFrom = null;
  try {
    const head = readFileSync(path, 'utf8').slice(0, 2000);
    const m = head.match(/^from:\s*(.+)$/m);
    if (m) fmFrom = m[1].trim();
  } catch {}
  const fn = basename(path).match(/^(?:訊息|請求|公告)_([^→_]+)→/);
  return { frontmatter: fmFrom, filename: fn ? fn[1].trim() : null };
}

/** 名字（中文名或代稱）→ 白名單 email。找不到回 null。 */
export function emailForName(name) {
  if (!name) return null;
  for (const [email, label] of Object.entries(WHITELIST)) {
    if (label.split(/\s+/).some((part) => part === name) || label === name) return email;
  }
  return null;
}

export function verdict(path, ownerEmail) {
  const claimed = claimedSender(path);
  const claimedName = claimed.frontmatter ?? claimed.filename;
  const inList = ownerEmail ? Object.hasOwn(WHITELIST, ownerEmail) : false;
  const expectedEmail = emailForName(claimedName);

  const anomalies = [];
  if (Object.keys(WHITELIST).length === 0) {
    anomalies.push('白名單未設定（config.md 沒有「白名單：」行）——請使用者把所有成員的 email 與名字填進 team-mailbox 的 config.md');
  }
  if (!ownerEmail) anomalies.push('拿不到 Drive owner（掛載外的檔或 API 失敗）');
  if (ownerEmail && !inList) anomalies.push(`owner ${ownerEmail} 不在白名單`);
  if (ownerEmail && expectedEmail && ownerEmail !== expectedEmail) {
    anomalies.push(`宣稱寄件人 ${claimedName}（應為 ${expectedEmail}）與實際 owner ${ownerEmail} 不一致——from 可能被冒寫`);
  }
  if (claimed.frontmatter && claimed.filename && claimed.frontmatter !== claimed.filename) {
    anomalies.push(`frontmatter from（${claimed.frontmatter}）與檔名寄件人（${claimed.filename}）不一致`);
  }

  const pass = anomalies.length === 0;
  return {
    stage: 'verdict',
    file: basename(path),
    owner: ownerEmail ?? null,
    ownerName: inList ? WHITELIST[ownerEmail] : null,
    claimed,
    pass,
    anomaly: anomalies,
    // tierFloor＝授權等級下限：閘門沒過一律 2（分類器只能更保守、不能降回來）
    tierFloor: pass ? 0 : 2,
    note: pass ? null : '名單外／異常：照樣收信、照樣告訴使用者，但不自動回覆，且要主動告知異常內容',
  };
}

// CLI 介面（比對用 pathToFileURL：路徑含空白或反斜線時字串比對會靜默失效）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const path = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--owner');
  const oi = args.indexOf('--owner');
  const owner = oi >= 0 ? (args[oi + 1] ?? null) : undefined;
  if (!path) { console.error('用法: gate.mjs <訊息檔> [--owner <email>]'); process.exit(2); }

  if (owner === undefined) {
    const itemId = driveItemId(path);
    process.stdout.write(JSON.stringify({
      stage: 'need-owner',
      file: basename(path),
      itemId,
      claimed: claimedSender(path),
      next: itemId
        ? `用 Drive MCP 的 get_file_metadata 查 fileId=${itemId} 的 owner，再跑 gate.mjs <檔> --owner <email>`
        : '拿不到 itemId（Windows 或掛載異常）：改用 Drive MCP 在該收件匣資料夾內以「檔名完全一致」搜尋反查——恰好命中一筆才取其 owner email 進第二段；命中 0 筆或 2 筆以上（同名檔）一律跑 gate.mjs <檔> --owner "" 走異常判定，不要自行挑一筆',
    }) + '\n');
  } else {
    process.stdout.write(JSON.stringify(verdict(path, owner || null)) + '\n');
  }
  process.exit(0);
}
