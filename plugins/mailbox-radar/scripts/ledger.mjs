// mailbox-radar · 已讀帳的行解析（0.8.1）
//
// 做一件事：從已讀帳（read.md）的一行，取出「這行記的是哪個檔名」。
//
// 為什麼獨立成一支：detect.mjs 的 readLedger（雷達判斷未讀）與 markread.mjs 的 ledgerEntries
// （記帳判斷記過沒）原本各抄一份同樣的切分規則。兩邊只要有一邊改了另一邊沒跟上，就會出現
// 「記了但雷達還是算未讀」這種最難查的狀況。規則只留這一份，兩邊都 import。
//
// 規則：檔名＝從行首（去掉條列符號後）到「第一個後面緊接行尾、括號或空白的 .md／.html」為止。
// 用副檔名定位結尾，而不是遇到空白或括號就切——0.8.0 以前是後者，檔名本身帶空白
// （例如 `AB X1 市場調查.html`）會在檔名中間被切斷，切出來的第一段沒有副檔名，
// 那一行就不算數，該檔不管記帳幾次都永遠被報未讀（2026-09-30 使用者回報）。
//
// 三種既有寫法都要認得：
//   `- 檔名.md（2026-09-30 已處理）`   ← markread 寫的
//   `- 檔名.md — 手寫備註`              ← 舊手寫格式
//   `- 公告板/檔名.md 手寫備註`         ← 帶資料夾前綴、空白後直接接備註
//
// 已知限制：檔名中間出現「.md」或「.html」且後面緊接空白或括號（例如 `甲.md 備份.md`）
// 會在第一個副檔名處結束。這種檔名請改名。

const BULLET_RE = /^\s*(?:[-*+]|\d+[.)])\s*/;
const NAME_RE = /^(.+?\.(?:md|html))(?=$|[（(\s])/i;

/**
 * 已讀帳的一行記的是哪個檔名（純檔名，不含資料夾前綴）。這行不是一筆記錄就回 null。
 * @param {string} line
 * @returns {string|null}
 */
export function ledgerLineName(line) {
  const body = String(line ?? '').replace(BULLET_RE, '').trim();
  const m = body.match(NAME_RE);
  if (!m) return null;
  // 條目可能帶資料夾前綴（公告板/…、收件匣-X/…），掃描端用純檔名比對，所以取 basename（0.4.3）。
  // 分隔符正反斜線都認（Windows）。
  const parts = m[1].split(/[\\/]/);
  const name = parts.pop();
  // 前綴裡有空白或括號＝這行其實是一句話、後面剛好提到某個路徑（「已轉給對方 見 公告板/附件_X.md」），
  // 不是一筆記錄。算錯的方向是「靜默隱藏一封沒人看過的訊息」，比多報一筆嚴重得多，所以不認。
  if (parts.some((p) => /[（(\s]/.test(p))) return null;
  return name || null;
}

/** 整份已讀帳 → 檔名集合。 */
export function ledgerNames(raw) {
  const seen = new Set();
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const name = ledgerLineName(line);
    if (name) seen.add(name);
  }
  return seen;
}
