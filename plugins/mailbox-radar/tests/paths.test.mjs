// 逐支心跳與名冊的驗收測試。跑法：node tests/paths.test.mjs
// 測試資料寫在系統暫存目錄，不碰真實 data dir。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
// 動態 import 要轉 file:// URL，否則 Windows 絕對路徑的 C: 會被當成 protocol
const P = await import(pathToFileURL(join(HERE, '..', 'scripts', 'paths.mjs')).href);
const root = join(tmpdir(), 'mailbox-radar-paths-test');
rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true });
let n = 0, fail = 0;
const eq = (name, got, want) => { n++; if (got !== want) { fail++; console.log(`✗ ${name}: got ${got} want ${want}`); } else console.log(`✓ ${name}`); };
const skip = (name, why) => console.log(`－ ${name}（跳過：${why}）`);
const hb = (sess, ageMs, extra = {}) => { mkdirSync(P.watchersDir(root), { recursive: true }); writeFileSync(P.heartbeatPath(root, sess), JSON.stringify({ at: new Date(Date.now() - ageMs).toISOString(), pid: 1, ...extra })); };

eq('沒有心跳檔 → never', P.watcherStatus(root), 'never');
hb('s1', 11 * 60_000);
eq('只有過期檔 → stale', P.watcherStatus(root), 'stale');
hb('s2', 5_000);
eq('一支新鮮 → 機器 alive', P.watcherStatus(root), 'alive');
eq('s1 自己看 → stale（不被 s2 遮蔽）', P.sessionWatcherStatus(root, 's1'), 'stale');
eq('s2 自己看 → alive', P.sessionWatcherStatus(root, 's2'), 'alive');
eq('沒有的 session → never', P.sessionWatcherStatus(root, 'nope'), 'never');
eq('sessionKey 清洗', P.sessionKey('ab/c d:e'), 'ab_c_d_e');
eq('resolveDataDir --data 優先', P.resolveDataDir(['node', 'x', '--data', '/tmp/zz']), '/tmp/zz');
process.env.MAILBOX_RADAR_DATA = '/tmp/yy';
eq('resolveDataDir env 覆寫', P.resolveDataDir(['node', 'x']), '/tmp/yy');
delete process.env.MAILBOX_RADAR_DATA;
const saved = process.env.CLAUDE_PLUGIN_DATA; process.env.CLAUDE_PLUGIN_DATA = '/should/be/ignored';
eq('忽略 CLAUDE_PLUGIN_DATA → canonical', P.resolveDataDir(['node', 'x']), P.CANONICAL_DATA_DIR);
if (saved === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = saved;
const sd = join(root, 'socks'); mkdirSync(sd); writeFileSync(join(sd, '1.sock'), ''); writeFileSync(join(sd, 'junk.txt'), '');
if (process.platform === 'win32') {
  // Windows 的 liveSockets 走 \\.\pipe\ 列舉、不看傳入的目錄，這條在 Windows 測的是真實 pipe 數，沒有意義
  skip('liveSockets 只算 .sock', 'Windows 走 named pipe 列舉，不用目錄');
  eq('Windows liveSockets 回陣列不拋錯', Array.isArray(P.liveSockets()), true);
  eq('Windows socketDirs 回空陣列', P.socketDirs().length, 0);
} else {
  eq('liveSockets 只算 .sock', P.liveSockets(sd).length, 1);
}
eq('socketAlive 存在', P.socketAlive(join(sd, '1.sock')), true);
eq('socketAlive 不存在', P.socketAlive(join(sd, '2.sock')), false);
eq('socketAlive null → null', P.socketAlive(null), null);
eq('readHeartbeats 數量', P.readHeartbeats(root).length, 2);
eq('socketLabel 取尾段（Unix 形）', P.socketLabel('/tmp/cc-socks/123.sock'), '123.sock');
eq('socketLabel 取尾段（Windows 形）', P.socketLabel('\\\\.\\pipe\\LOCAL\\cc-msg-abc'), 'cc-msg-abc');

// 心跳是不是別的版本的程式寫的（plugin 更新後，常駐行程還在跑舊版）
const cur = join(root, 'cache', '0.7.1', 'scripts', 'watcher.mjs');
hb('v-same', 1_000, { script: cur });
hb('v-old', 1_000, { script: join(root, 'cache', '0.7.0', 'scripts', 'watcher.mjs') });
hb('v-none', 1_000);
eq('換版：同一支程式 → 不算別的版本', P.heartbeatFromOtherVersion(P.heartbeatPath(root, 'v-same'), cur), false);
eq('換版：路徑裡的版號不同 → 別的版本', P.heartbeatFromOtherVersion(P.heartbeatPath(root, 'v-old'), cur), true);
eq('換版：心跳沒記程式路徑（還不會記的舊版）→ 別的版本', P.heartbeatFromOtherVersion(P.heartbeatPath(root, 'v-none'), cur), true);
eq('換版：沒有心跳檔 → 不判斷', P.heartbeatFromOtherVersion(P.heartbeatPath(root, 'v-missing'), cur), false);
if (process.platform === 'win32') {
  eq('換版：Windows 路徑不分大小寫與斜線方向', P.heartbeatFromOtherVersion(P.heartbeatPath(root, 'v-same'), cur.toUpperCase().replace(/\\/g, '/')), false);
} else skip('換版：Windows 路徑不分大小寫與斜線方向', '非 Windows');
console.log(`\n${n - fail}/${n} 通過`);
rmSync(root, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
