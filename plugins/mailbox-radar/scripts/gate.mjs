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

import { findContact, loadContacts, readLegacyWhitelist, resolveContactsPath } from './contacts.mjs';

// 名單住本機（放交換區的話，能寫那個資料夾的人就能把自己加進去，等於沒有名單）。
// 0.6.0 起來源＝使用者資料目錄的 通訊錄.md（見 contacts.mjs 檔頭）；0.5.x 的 config.md
// 「白名單：」行由 SessionStart 自動轉入通訊錄。通訊錄還沒建出來之前（轉入尚未發生的那個
// 空窗）退回讀 config.md 的白名單行，讓純查詢的呼叫端在升級瞬間也答得對。
// 不放在 plugin 目錄裡：那是版本化快取，更新就被覆蓋。

/**
 * 讀名單。回 contacts.mjs 的陣列形狀（email／aliases／name／source／status）。
 * 通訊錄不存在時退回 config.md 白名單行（全部視為 manual／active）。
 */
export function loadRoster(contactsPath = resolveContactsPath()) {
  const list = loadContacts(contactsPath);
  if (list.length > 0) return list;
  return readLegacyWhitelist().map(({ email, label }) => ({
    email, aliases: label.split(/\s+/), name: '', source: 'manual', status: 'active',
  }));
}

/** 相容 0.5.x 的形狀 {email: 名字}：只含 active 的人。舊呼叫端用；新碼請用 loadRoster。 */
export function loadWhitelist(contactsPath = resolveContactsPath()) {
  const out = {};
  for (const c of loadRoster(contactsPath)) {
    if (c.status === 'active') out[c.email] = [...c.aliases, c.name].filter(Boolean).join(' ');
  }
  return out;
}

export const ROSTER = loadRoster();
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

/** 名字（代稱或姓名）→ email。找不到回 null。left 的人也查得到（對帳要認得出離職者）。 */
export function emailForName(name, roster = ROSTER) {
  if (!name) return null;
  return findContact(roster, name)?.email ?? null;
}

export function verdict(path, ownerEmail, roster = ROSTER) {
  const claimed = claimedSender(path);
  const claimedName = claimed.frontmatter ?? claimed.filename;
  const owner = ownerEmail ? String(ownerEmail).trim().toLowerCase() : null;
  const entry = owner ? roster.find((c) => c.email === owner) ?? null : null;
  const inList = !!entry && entry.status === 'active';
  const expectedEmail = emailForName(claimedName, roster);

  const anomalies = [];
  if (roster.length === 0) {
    anomalies.push('通訊錄是空的（~/.claude/team-mailbox/通訊錄.md 不存在或沒有成員）——請使用者對 Claude 說「同步通訊錄」從 Drive 分享名單帶入，或「通訊錄加人」手動加');
  }
  if (!owner) anomalies.push('拿不到 Drive owner（掛載外的檔或 API 失敗）');
  if (owner && !entry) anomalies.push(`owner ${owner} 不在通訊錄`);
  if (owner && entry && entry.status !== 'active') anomalies.push(`owner ${owner}（${[...entry.aliases, entry.name].filter(Boolean).join('／') || '無代稱'}）在通訊錄標記為已離開（left）`);
  if (owner && expectedEmail && owner !== expectedEmail) {
    anomalies.push(`宣稱寄件人 ${claimedName}（應為 ${expectedEmail}）與實際 owner ${owner} 不一致——from 可能被冒寫`);
  }
  if (claimed.frontmatter && claimed.filename && claimed.frontmatter !== claimed.filename) {
    anomalies.push(`frontmatter from（${claimed.frontmatter}）與檔名寄件人（${claimed.filename}）不一致`);
  }

  const pass = anomalies.length === 0;
  return {
    stage: 'verdict',
    file: basename(path),
    owner,
    ownerName: inList ? ([...entry.aliases, entry.name].filter(Boolean).join(' ') || null) : null,
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
