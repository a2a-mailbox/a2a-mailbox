#!/usr/bin/env node
// team-mailbox-radar · 狀態列
//
// 為什麼是複合的一行、而不是只印未讀數：官方文件明寫「設了自訂 statusLine 之後，
// Claude Code 就不再顯示 footer 上大部分的鍵盤提示」。只印 📬 會讓使用者白白損失那些提示，
// 所以這一行也把模型、目錄、context 用量帶上。
//
// 零 token：statusLine 的輸出只畫在畫面上，不進模型 context。
// 成本只有每次 refresh 的一次 node 啟動（約 40–60 毫秒 CPU）。
//
// 用法（各人的 settings.json）：
//   "statusLine": { "type": "command",
//                   "command": "node <plugin>/scripts/statusline.mjs",
//                   "refreshInterval": 15 }

import { detect } from './detect.mjs';
import { watcherStatus } from './paths.mjs';

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({});
    let buf = '';
    const done = () => { try { resolve(buf.trim() ? JSON.parse(buf) : {}); } catch { resolve({}); } };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', done);
    process.stdin.on('error', () => resolve({}));
    // unref：這個保險計時器不該把行程留在事件迴圈裡等滿兩秒
    setTimeout(done, 2000).unref();
  });
}

const input = await readStdin();
const parts = [];

const model = input?.model?.display_name;
if (model) parts.push(`[${model}]`);

const dir = input?.workspace?.current_dir;
if (dir) parts.push(`📁 ${dir.split(/[\\/]/).filter(Boolean).pop()}`);

const pct = input?.context_window?.used_percentage;
if (typeof pct === 'number') parts.push(`${Math.round(pct)}% ctx`);

// 信箱段：沒裝 team-mailbox（errorKind 'config'）整段不印；
// 有裝但讀不到交換區（errorKind 'scan'）印 📪⚠️——讓人一眼看出雷達死了（task 6）
try {
  const r = detect();
  if (r.ok) {
    parts.push(r.unreadCount > 0 ? `📬 ${r.unreadCount}` : '📭');
    if (watcherStatus() === 'stale') parts.push('🔕 通知器停'); // 心跳過期（>10 分鐘）
  }
  else if (r.errorKind === 'scan') parts.push('📪⚠️');
} catch {
  // 靜默
}

process.stdout.write(parts.join(' | ') + '\n');
process.exit(0); // 明確退出：statusLine 每次 refresh 都跑一次，不能讓行程多留任何一刻
