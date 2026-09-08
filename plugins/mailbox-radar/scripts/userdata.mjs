// mailbox-radar · 使用者資料目錄（config.md、已讀帳、通訊錄）
//
// 為什麼獨立一支、不併進 paths.mjs：
//   paths.mjs 管的是 plugin 的「機器狀態」（心跳、鎖、session 節流帳），那些東西
//   跟著 plugin 走、更新時重建無所謂。這支管的是「使用者資料」——使用者親手填的
//   設定與累積的已讀帳，plugin 更新絕對不能碰。兩者生命週期不同，混在一起遲早出事。
//
// 位置從 ~/.claude/skills/team-mailbox/ 搬到 ~/.claude/team-mailbox/ 的理由：
//   skill 本體要進 plugin（plugins/mailbox-radar/skills/team-mailbox/），而 plugin 快取
//   目錄在每次更新時會被整個換掉。使用者資料留在那裡會被更新清掉，所以要搬到快取之外。
//
// 搬遷是自動且冪等的：第一次有人讀設定時觸發，搬完在舊位置留一個指標檔。

import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 新家。可用環境變數覆寫——測試要在隔離的假 HOME 下跑，不能碰使用者真的設定。 */
export const USER_DATA_DIR = process.env.TEAM_MAILBOX_USER_DATA
  || join(homedir(), '.claude', 'team-mailbox');

/** 舊家（0.5.x 以前）。只讀不寫，唯一會寫的動作是搬遷完留指標。 */
export const LEGACY_DIR = process.env.TEAM_MAILBOX_LEGACY_DIR
  || join(homedir(), '.claude', 'skills', 'team-mailbox');

/**
 * 屬於「使用者資料」的檔案，只有這些會被搬。
 * 刻意不搬 SKILL.md 與 references/：那是 skill 本體，新版由 plugin 提供，
 * 舊位置那份是上一次安裝的殘留。留著不影響運作，使用者想清可以自己刪
 * （指標檔裡會說明），我們不替他刪別人裝的東西。
 */
const USER_FILES = ['config.md', 'read.md', '通訊錄.md'];

const POINTER_NAME = '已搬遷至.md';

let migrationChecked = false;

function pointerBody() {
  return `# 這個資料夾的使用者資料已經搬走了

信箱雷達（mailbox-radar）把使用者資料搬到：

    ${USER_DATA_DIR}

## 為什麼要搬

skill 本體現在住在 plugin 裡面，而 plugin 的快取目錄每次更新都會被整個換掉。
設定與已讀帳留在那裡會被更新清掉，所以移到快取之外的固定位置。

## 這裡還剩下什麼

搬走的是 ${USER_FILES.join('、')}。
如果這個資料夾裡還有 SKILL.md 或 references/，那是上一次安裝 skill 留下的殘留，
新版由 plugin 提供、不再讀這裡。留著不影響運作，你想清掉可以整個資料夾刪除。
`;
}

/**
 * 確保使用者資料在新位置。第一次呼叫時檢查是否需要從舊位置搬遷。
 * 冪等：搬過就不再搬；新位置已有同名檔案時**不覆蓋**（新的優先，舊的留在原地）。
 * @returns {{migrated: string[], skipped: string[]}} 這次實際搬了什麼
 */
export function ensureUserData() {
  const result = { migrated: [], skipped: [] };
  if (migrationChecked) return result;
  migrationChecked = true;

  mkdirSync(USER_DATA_DIR, { recursive: true });

  // 舊位置沒有 config.md 就沒有東西要搬（全新安裝走這條）
  if (!existsSync(join(LEGACY_DIR, 'config.md'))) return result;

  for (const name of USER_FILES) {
    const from = join(LEGACY_DIR, name);
    const to = join(USER_DATA_DIR, name);
    if (!existsSync(from)) continue;
    if (existsSync(to)) { result.skipped.push(name); continue; }
    try {
      renameSync(from, to);
      result.migrated.push(name);
    } catch {
      // 跨磁碟或檔案被鎖住時 rename 會失敗，退成複製再刪
      try {
        copyFileSync(from, to);
        unlinkSync(from);
        result.migrated.push(name);
      } catch {
        result.skipped.push(name);
      }
    }
  }

  if (result.migrated.length > 0) {
    try { writeFileSync(join(LEGACY_DIR, POINTER_NAME), pointerBody()); } catch {}
  }
  return result;
}

/**
 * 使用者資料檔的實際位置——**純讀取、沒有副作用**。
 *
 * 新位置優先；還沒搬遷過就退回舊位置，這樣「搬遷尚未發生」的狀態下一切照常運作。
 * 兩邊都沒有時回新位置，因為那是「應該建在哪」的答案。
 *
 * 刻意不在這裡觸發搬遷：取路徑看起來是唯讀操作，把寫入副作用藏在後面，會讓測試、
 * CLI 工具、狀態列這些純查詢的呼叫端意外搬動使用者的檔案。2026-09-08 實際踩到——
 * 跑一次測試就把真實的 config.md 搬走，導致當時正在運作的雷達當場讀不到設定。
 * 搬遷只在 SessionStart 由 inject.mjs 明確呼叫 ensureUserData() 執行。
 */
export function userDataPath(name) {
  const preferred = join(USER_DATA_DIR, name);
  if (existsSync(preferred)) return preferred;
  const legacy = join(LEGACY_DIR, name);
  if (existsSync(legacy)) return legacy;
  return preferred;
}

export function configPath() { return userDataPath('config.md'); }
export function ledgerPath() { return userDataPath('read.md'); }
export function contactsPath() { return userDataPath('通訊錄.md'); }

/**
 * 設定是否已備妥。新舊位置任一有 config.md 就算數（搬遷前後都要答對）。
 * 給開場注入判斷要不要提示使用者建設定用。純讀取。
 */
export function isConfigured() {
  return existsSync(join(USER_DATA_DIR, 'config.md'))
    || existsSync(join(LEGACY_DIR, 'config.md'));
}

/** 測試用：重置「已檢查搬遷」的旗標，讓同一個行程能跑多輪情境。 */
export function _resetForTest() {
  migrationChecked = false;
}

/** 測試用：列出使用者資料目錄現有內容。 */
export function _listUserData() {
  try { return readdirSync(USER_DATA_DIR).sort(); } catch { return []; }
}
