#!/usr/bin/env node
// mailbox-radar · 通訊錄（Phase 6 task 3）
//
// 通訊錄是「交換區成員名單」的唯一正本，住在使用者資料目錄：~/.claude/team-mailbox/通訊錄.md。
// 兩個消費者：
//   * gate.mjs（白名單閘門）——訊息檔的 Drive owner 在不在名單、宣稱的寄件人對不對得上
//   * team-mailbox skill——寄信前確認對象還在（狀態 active）、代稱↔email 互查
//
// 為什麼從 config.md 的「白名單：」行獨立成一個檔：
//   白名單只有 email＋一個名字，而實際需要的是「email、代稱（可多個）、姓名、來源、狀態」
//   五欄——代稱與姓名是兩個東西（代稱＝收件匣資料夾後綴，人工取的；姓名＝Drive 顯示名，
//   通常是中文全名），實測多數人對不上，不能合成一欄。而且名單要能從 Drive 分享名單同步、
//   要能標記「已離開」而不是刪列（刪了閘門就認不出離職者的舊訊息）。這些都塞不進一行 config。
//
// 檔案格式（markdown 表格，人看機讀）：
//
//   | email | 代稱 | 姓名 | 來源 | 狀態 |
//   |---|---|---|---|---|
//   | alice@example.com | Alice、小A | 王小艾 | drive | active |
//
//   代稱可多個，用「、」分隔，第一個＝收件匣資料夾後綴（`收件匣-Alice`）。
//   來源 drive＝由 Drive 分享名單同步；manual＝人工加的。狀態 active＝在用；left＝已離開。
//   表格以外的行（標題、註解）解析時忽略，可以自由寫。
//
// 分工（同 gate.mjs 的兩段式精神）：
//   Drive API 只在 session 的 MCP 手上，所以「去 Drive 撈成員」是 skill 規程、由 Claude 做；
//   撈回來的事實寫成 JSON 交給本檔的 sync，**合併規則全部在這裡**（可測試、可重跑、不靠模型記憶）。
//
// 用法：
//   node contacts.mjs list [--pretty]
//   node contacts.mjs add <email> <代稱> [--name <姓名>]
//   node contacts.mjs remove <email 或代稱>            → 標 left，不刪列
//   node contacts.mjs check <email 或代稱>             → 寄信前查對象
//   node contacts.mjs sync --facts <json 檔> [--dry-run]
//   node contacts.mjs migrate                          → config.md 的白名單行 → 通訊錄（冪等）

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import { configPath as defaultConfigPath, contactsPath as defaultContactsPath } from './userdata.mjs';

export const SOURCES = new Set(['drive', 'manual']);
export const STATUSES = new Set(['active', 'left']);

/** 通訊錄檔位置：環境變數覆寫只給測試與除錯用。 */
export function resolveContactsPath(p) {
  return p || process.env.MAILBOX_RADAR_CONTACTS || defaultContactsPath();
}

// ── 解析與序列化 ──────────────────────────────────────────────

const ALIAS_SEP = /[、,，;／/]+/;

export function normalizeEmail(s) {
  return String(s ?? '').trim().toLowerCase();
}

export function splitAliases(s) {
  return String(s ?? '').split(ALIAS_SEP).map((a) => a.trim()).filter(Boolean);
}

/**
 * 把通訊錄檔文字解析成陣列。只認表格行；欄位順序固定 email｜代稱｜姓名｜來源｜狀態。
 * 分隔符全形「｜」與半形「|」都認（人手打的常混用）。
 * 不合法的來源／狀態值退成 manual／active——寧可多認一個人，不要因為打錯字把人靜默踢出名單。
 * @returns {Array<{email:string, aliases:string[], name:string, source:string, status:string}>}
 */
export function parseContacts(raw) {
  const out = [];
  const seen = new Set();
  for (let line of String(raw ?? '').replace(/^﻿/, '').split(/\r?\n/)) {
    line = line.trim();
    if (!/^[|｜]/.test(line)) continue;
    const cells = line.replace(/^[|｜]/, '').replace(/[|｜]$/, '').split(/[|｜]/).map((c) => c.trim());
    if (cells.length < 2) continue;
    const email = normalizeEmail(cells[0]);
    // 表頭與分隔行：第一格不是 email 就跳過
    if (!email.includes('@')) continue;
    if (seen.has(email)) continue; // 同 email 重複列，取第一列
    seen.add(email);
    const source = SOURCES.has((cells[3] ?? '').toLowerCase()) ? cells[3].toLowerCase() : 'manual';
    const status = STATUSES.has((cells[4] ?? '').toLowerCase()) ? cells[4].toLowerCase() : 'active';
    out.push({ email, aliases: splitAliases(cells[1]), name: cells[2] ?? '', source, status });
  }
  return out;
}

export function serializeContacts(list, { syncedAt = null } = {}) {
  const lines = [
    '# 通訊錄',
    '',
    '> 交換區成員名單，信箱雷達（白名單閘門）與 team-mailbox skill（寄信前查對象）共用。',
    '> 代稱可多個，用「、」分隔，第一個是收件匣資料夾的後綴；代稱與姓名是兩回事，不要合併。',
    '> 來源：drive＝由 Drive 分享名單同步；manual＝人工加入。狀態：active＝在用；left＝已離開（不刪列，寄件會被擋、舊訊息仍認得出是誰）。',
    '> 改這個檔可以直接用 Claude：「通訊錄加人」「通訊錄移除 <人>」「同步通訊錄」「列出通訊錄」。',
  ];
  if (syncedAt) lines.push(`> 最後同步：${syncedAt}`);
  lines.push('', '| email | 代稱 | 姓名 | 來源 | 狀態 |', '|---|---|---|---|---|');
  for (const c of list) {
    lines.push(`| ${c.email} | ${c.aliases.join('、')} | ${c.name ?? ''} | ${c.source} | ${c.status} |`);
  }
  lines.push('');
  return lines.join('\n');
}

// ── 讀寫 ───────────────────────────────────────────────────────

/** 純讀取。檔案不存在＝空名單（不是錯誤）。 */
export function loadContacts(path) {
  const p = resolveContactsPath(path);
  try {
    return parseContacts(readFileSync(p, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

export function saveContacts(list, path, opts = {}) {
  const p = resolveContactsPath(path);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, serializeContacts(list, opts));
  return p;
}

/** 現在時刻，通訊錄註記用（本地時間、到分）。 */
function stamp(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

// ── 查詢 ───────────────────────────────────────────────────────

/** 用 email、代稱或姓名找人。找不到回 null。 */
export function findContact(list, key) {
  const k = String(key ?? '').trim();
  if (!k) return null;
  const byEmail = list.find((c) => c.email === normalizeEmail(k));
  if (byEmail) return byEmail;
  return list.find((c) => c.aliases.includes(k) || (c.name && c.name === k)) ?? null;
}

/** 寄信前查對象：回 {found, active, entry, note}。note 是要對使用者講的話（沒問題時 null）。 */
export function checkRecipient(list, key) {
  const entry = findContact(list, key);
  if (!entry) {
    return {
      found: false, active: false, entry: null,
      note: `「${key}」不在通訊錄裡。可能是代稱打錯、或還沒同步／加入。收件匣資料夾若存在仍可寄，但請先跟使用者確認對象。`,
    };
  }
  if (entry.status !== 'active') {
    return {
      found: true, active: false, entry,
      note: `「${key}」在通訊錄裡標記為已離開（left），不要寄。若他其實回來了，請使用者說「通訊錄加人」重新啟用。`,
    };
  }
  return { found: true, active: true, entry, note: null };
}

// ── 人工維護 ───────────────────────────────────────────────────

/**
 * 加人（或替既有的人補代稱／姓名）。回 {list, action}，action ∈ added | updated | reactivated。
 * 既有的人：代稱只增不減；姓名只在原本空白時填（人工填過的不覆蓋）；left 的人會被重新啟用。
 */
export function addContact(list, { email, alias, name = '' }) {
  const e = normalizeEmail(email);
  if (!e.includes('@')) throw new Error(`email 格式不對：${email}`);
  const aliases = splitAliases(alias);
  const existing = list.find((c) => c.email === e);
  if (!existing) {
    const entry = { email: e, aliases, name: name.trim(), source: 'manual', status: 'active' };
    return { list: [...list, entry], action: 'added', entry };
  }
  let action = 'updated';
  for (const a of aliases) if (!existing.aliases.includes(a)) existing.aliases.push(a);
  if (name.trim() && !existing.name) existing.name = name.trim();
  if (existing.status !== 'active') { existing.status = 'active'; action = 'reactivated'; }
  return { list, action, entry: existing };
}

/** 移除＝標 left，不刪列。回 {list, entry}；找不到 entry 為 null。 */
export function removeContact(list, key) {
  const entry = findContact(list, key);
  if (!entry) return { list, entry: null };
  entry.status = 'left';
  return { list, entry };
}

// ── Drive 同步（合併規則）─────────────────────────────────────
//
// facts 的形狀（由 Claude 從 Drive 工具的回傳整理出來，欄位缺了就當沒有）：
//   {
//     members: [{ email, role }],            // 交換區父層 permissions：誰有存取權
//     names:   { "<email>": "<顯示名>" },    // 從 Last Edited By 蒐集到的 email→姓名
//     folderAliases: ["Alice", "Bob"],       // 收件匣-<代稱> 資料夾名去掉前綴
//     aliasMap: { "<代稱>": "<email>" },     // 代稱↔email 的對應（檔名署名對 Last Edited By 的證據、或使用者確認的）
//     selfName: "Alice"                      // 自己的代稱，健檢用；缺了會去讀 config.md 的「名字」，都沒有＝健檢不跑
//   }
//
// 規則（每條都對應一個測試）：
//   1. members 是「誰在名單上」的權威：不在 members 裡、來源是 drive 的人 → 標 left（不刪）
//   2. 來源 manual 的人不受 members 影響（人工加的，人工移除），但會列在 report 裡提醒
//   3. 新 email → 新列，來源 drive；left 的人重新出現在 members → 回 active
//   4. 姓名：有新值且（原本空白 或 來源 drive）才寫；來源 manual 且已有姓名 → 不覆寫
//   5. 代稱：只增不減。aliasMap 給的代稱加進去；自動對應只做兩種零歧義的：
//        a. 代稱＝既有列的某個代稱或姓名  b. 代稱＝顯示名（names 裡的值）
//      其餘代稱與 email 都留在 unmapped 裡，交給 Claude 問使用者，**不猜**
//   6. 已知代稱不因同步而改名（人工代稱優先於任何推斷）

function autoAliasMap(list, facts) {
  const map = { ...(facts.aliasMap ?? {}) };
  const nameToEmail = {};
  for (const [email, name] of Object.entries(facts.names ?? {})) {
    if (name) nameToEmail[String(name).trim()] = normalizeEmail(email);
  }
  for (const alias of facts.folderAliases ?? []) {
    if (map[alias]) { map[alias] = normalizeEmail(map[alias]); continue; }
    const known = list.find((c) => c.aliases.includes(alias) || c.name === alias);
    if (known) { map[alias] = known.email; continue; }
    if (nameToEmail[alias]) map[alias] = nameToEmail[alias];
  }
  return map;
}

/**
 * 把 Drive 事實合併進通訊錄。純函式：回新陣列與報告，不寫檔。
 * @returns {{list, report:{added:string[], left:string[], reactivated:string[], renamed:string[], manualNotInDrive:string[], unmappedAliases:string[], unmappedEmails:string[], warnings:string[]}}}
 */
export function mergeFromDrive(list, facts) {
  const next = list.map((c) => ({ ...c, aliases: [...c.aliases] }));
  const report = { added: [], left: [], reactivated: [], renamed: [], manualNotInDrive: [], unmappedAliases: [], unmappedEmails: [], warnings: [] };
  const members = (facts.members ?? []).map((m) => normalizeEmail(m.email)).filter((e) => e.includes('@'));
  const memberSet = new Set(members);
  const names = Object.fromEntries(Object.entries(facts.names ?? {}).map(([e, n]) => [normalizeEmail(e), String(n ?? '').trim()]));
  const aliasMap = autoAliasMap(next, facts);
  const emailToAliases = {};
  for (const [alias, email] of Object.entries(aliasMap)) (emailToAliases[email] ??= []).push(alias);

  // 防呆：分享名單只有一筆或是空的，而通訊錄裡還有其他由 Drive 同步來的人。
  // 這多半不是大家都離開了，而是查詢工具只回擁有者——實測過有 Drive 連接器查資料夾
  // permissions 只給擁有者一筆、不列其他成員。照規則 1 硬套，會把其他人全部標成離開，
  // 閘門接著把他們的訊息都判成異常，而且當下完全沒有跡象。所以寧可這次一個都不標，
  // 把狀況寫進 warnings 讓人決定。代價是「兩人交換區真的有人離開」時不會自動標，用 remove 手動標即可。
  const wouldLeave = next.filter((c) => c.source === 'drive' && c.status === 'active' && !memberSet.has(c.email));
  const distrustMembers = members.length <= 1 && wouldLeave.length > 0;
  if (distrustMembers) {
    report.warnings.push(`分享名單只查到 ${members.length} 筆，但通訊錄裡還有 ${wouldLeave.length} 位由 Drive 同步來的成員不在其中。這多半是查詢工具只回擁有者、不列其他成員，不是他們都離開了，所以這次沒有把任何人標成離開。確實有人離開請用 remove 手動標；要完整同步請換一個能列出全部分享成員的 Drive 工具，或改用手動加人。`);
  }

  // 規則 1、2：現有的人對照 members
  for (const c of next) {
    if (memberSet.has(c.email)) {
      if (c.status !== 'active') { c.status = 'active'; report.reactivated.push(c.email); }
    } else if (c.source === 'drive') {
      if (distrustMembers) continue;
      if (c.status !== 'left') { c.status = 'left'; report.left.push(c.email); }
    } else {
      report.manualNotInDrive.push(c.email);
    }
  }

  // 規則 3：新 email
  for (const email of members) {
    if (next.some((c) => c.email === email)) continue;
    next.push({ email, aliases: [], name: '', source: 'drive', status: 'active' });
    report.added.push(email);
  }

  // 規則 4、5、6：姓名與代稱
  for (const c of next) {
    const newName = names[c.email];
    if (newName && (!c.name || c.source === 'drive') && newName !== c.name) {
      if (c.name) report.renamed.push(`${c.email}：${c.name} → ${newName}`);
      c.name = newName;
    }
    for (const a of emailToAliases[c.email] ?? []) if (!c.aliases.includes(a)) c.aliases.push(a);
  }

  // 對不上的：代稱沒有 email、或 email 沒有代稱
  for (const alias of facts.folderAliases ?? []) if (!aliasMap[alias]) report.unmappedAliases.push(alias);
  for (const c of next) if (c.status === 'active' && c.aliases.length === 0) report.unmappedEmails.push(c.email);

  return { list: next, report };
}

/**
 * 同步後健檢：自己那一列的姓名必須是滿的。
 * 理由：子資料夾是 setup 時由自己建的，它們的 Last Edited By 一定是自己；連自己都空，
 * 代表查詢本身出了問題（綁錯帳號、工具沒把顯示名印出來），不是「還沒有人傳訊息」。
 * @returns {string|null} 要對使用者講的警告；**確實檢查過且沒問題**才回 null
 *
 * 拿不到自己的代稱時**不回 null**：null 的意思是「檢查過、健康」，沒檢查不能冒充健康。
 * 這是設計上的防範，不是修一個觀測到的故障（2026-09-08 驗證時一度以為踩到，後來查明
 * 那次 config 讀得到、null 是真健康）。推論仍成立：第一次同步可能發生在 config.md 還沒建
 * 的機器上，那時靜默回 null 會讓人把「沒檢查」讀成「沒事」，所以 null 只能有一個意思。
 */
export const HEALTH_UNCHECKED = '健檢沒有跑：拿不到你自己的代稱（facts 沒帶 selfName、config.md 也沒有「名字」）。這不代表健康。請在 facts 加 "selfName": "<你的代稱>" 重跑一次 sync（可帶 --dry-run），健檢才會真的檢查你那一列。';

export function healthCheck(list, selfName) {
  if (!selfName) return HEALTH_UNCHECKED;
  const me = findContact(list, selfName);
  if (!me) return `通訊錄裡找不到你自己（代稱「${selfName}」）。同步的來源可能不是你的交換區，或代稱對應沒填到自己那一列。`;
  if (!me.name) return `通訊錄裡你自己那一列（${me.email}）姓名是空的。交換區的子資料夾是你建的，Last Edited By 一定有你，所以這不是「還沒人傳訊息」——多半是查詢綁錯 Google 帳號、或工具回傳沒帶顯示名。請重查一次。`;
  return null;
}

// ── config.md 白名單 → 通訊錄（升級轉入）──────────────────────

/** 從 config.md 讀舊格式「白名單：<email> <名字>」行。純讀取。 */
export function readLegacyWhitelist(configPath = process.env.MAILBOX_RADAR_CONFIG || defaultConfigPath()) {
  const out = [];
  try {
    for (const line of readFileSync(configPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^白名單\s*[：:]\s*(\S+)\s+(.+)$/);
      if (m) out.push({ email: normalizeEmail(m[1]), label: m[2].trim() });
    }
  } catch {}
  return out;
}

/**
 * 通訊錄不存在、而 config.md 有白名單行 → 產生通訊錄。冪等：通訊錄一存在就什麼都不做。
 * 只在 SessionStart 由 inject.mjs 明確呼叫（同 userdata 搬遷的紀律：寫入不藏在讀取後面）。
 * 白名單行留在 config.md 不動（不改使用者的檔），但 0.6.0 起閘門不再讀它。
 * @returns {{migrated:number, path:string|null}}
 */
export function migrateWhitelist({ contactsPath, configPath } = {}) {
  const p = resolveContactsPath(contactsPath);
  if (existsSync(p)) return { migrated: 0, path: null };
  const legacy = readLegacyWhitelist(configPath);
  if (legacy.length === 0) return { migrated: 0, path: null };
  let list = [];
  for (const { email, label } of legacy) {
    // 舊格式的「名字」欄常是「代稱 姓名」或只有代稱；全部當代稱收，姓名留給同步去補
    list = addContact(list, { email, alias: label.split(/\s+/).join('、') }).list;
  }
  saveContacts(list, p);
  return { migrated: list.length, path: p };
}

// ── CLI ────────────────────────────────────────────────────────

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? null) : null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const pretty = args.includes('--pretty');
  const out = (o) => process.stdout.write(JSON.stringify(o, null, pretty ? 2 : 0) + '\n');
  const positional = args.slice(1).filter((a, i, arr) => !a.startsWith('--') && !(arr[i - 1] ?? '').match(/^--(name|facts)$/));

  try {
    if (cmd === 'list') {
      out({ path: resolveContactsPath(), contacts: loadContacts() });
    } else if (cmd === 'add') {
      const [email, alias] = positional;
      if (!email || !alias) throw new Error('用法: contacts.mjs add <email> <代稱> [--name <姓名>]');
      const list = loadContacts();
      const r = addContact(list, { email, alias, name: flag(args, '--name') ?? '' });
      const path = saveContacts(r.list);
      out({ action: r.action, entry: r.entry, path });
    } else if (cmd === 'remove') {
      const [key] = positional;
      if (!key) throw new Error('用法: contacts.mjs remove <email 或代稱>');
      const list = loadContacts();
      const r = removeContact(list, key);
      if (!r.entry) { out({ action: 'not-found', key }); process.exit(1); }
      const path = saveContacts(r.list);
      out({ action: 'left', entry: r.entry, path });
    } else if (cmd === 'check') {
      const [key] = positional;
      if (!key) throw new Error('用法: contacts.mjs check <email 或代稱>');
      out(checkRecipient(loadContacts(), key));
    } else if (cmd === 'sync') {
      const factsPath = flag(args, '--facts');
      if (!factsPath) throw new Error('用法: contacts.mjs sync --facts <json 檔> [--dry-run]');
      const facts = JSON.parse(readFileSync(factsPath, 'utf8'));
      const before = loadContacts();
      const { list, report } = mergeFromDrive(before, facts);
      const dry = args.includes('--dry-run');
      const path = dry ? null : saveContacts(list, undefined, { syncedAt: stamp() });
      let selfName = facts.selfName ?? null;
      if (!selfName) {
        try {
          const m = readFileSync(process.env.MAILBOX_RADAR_CONFIG || defaultConfigPath(), 'utf8').match(/^名字\s*[：:]\s*(.+)$/m);
          selfName = m ? m[1].trim() : null;
        } catch {}
      }
      const health = healthCheck(list, selfName);
      out({ dryRun: dry, path, report, healthChecked: !!selfName, health, contacts: list });
    } else if (cmd === 'migrate') {
      out(migrateWhitelist());
    } else {
      console.error('用法: contacts.mjs list|add|remove|check|sync|migrate（詳見檔頭註解）');
      process.exit(2);
    }
  } catch (err) {
    console.error(String(err?.message ?? err));
    process.exit(1);
  }
  process.exit(0);
}
