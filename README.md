# a2a-mailbox · 信箱系統設置說明

讓你的 Claude 和朋友的 Claude 直接互傳訊息（Agent 對 Agent 信箱，走 Google Drive 共用資料夾）。支援 macOS 與原生 Windows。

這份 README 就是完整的設置說明，照順序看完、照做就能用。

## 一、為什麼要做這個

兩個人各自都有 Claude Code 的時候，常常出現這種場景：A 的 Claude 整理好了一份東西，A 要自己複製貼上傳給 B，B 再貼給自己的 Claude。**人變成兩個 AI 之間的傳話筒。**

這套系統讓兩邊的 Claude 直接互傳：一邊的 Claude 把訊息寫進 Google Drive 上一個共用資料夾（叫「交換區」），另一邊的 Claude 自己會發現：開新對話時它報給你聽，甚至你放著沒動的對話會在訊息到達後幾十秒內**自己醒過來**告訴你。純粹問資料的訊息，對方的 Claude 驗證過寄件人身分後還能直接代答，連人都不用等。

## 二、這東西用在哪裡（和用不到的地方）

**用得到：**

- 兩個以上的人，各自有 Claude Code（桌面版或終端機版都行），想讓彼此的 Claude 傳話、交換檔案指標、問資料
- 同一個人有兩臺電腦（例如一臺 Mac 一臺 Windows），想讓兩臺機器上的 Claude 互通

**用不到／要知道的限制：**

- 只有一臺機器、沒有要跟別人互傳：用不到
- Windows 上如果你的 Claude Code 是裝在 WSL2 裡，跟裝在原生 Windows 上的元件互相搆不到，**整套只能選一邊裝**（本包支援原生 Windows；WSL2 使用者請把它當 Linux 裝，交換區路徑要能從 WSL 讀到 Drive）
- 「訊息到達幾十秒內喚醒」需要對方那邊有開著的對話；沒開對話時，訊息會等到對方下次開對話時報出來。**不會漏，只是慢**
- 桌面版沒有狀態列未讀數（那是終端機版限定的加分項）

## 三、怎麼用（裝好之後）

### 寄訊息

你對你的 Claude 說：「傳訊息給小華：問她上次那份報告的最終版放在哪」

你的 Claude 會把這句話整理成一個訊息檔、寫進交換區裡小華的收件匣，然後告訴你檔名。就這樣，你不用碰任何資料夾。

### 收訊息

小華那邊（裝了同一套的機器）三種情況都會知道：

- 她開新對話：Claude 開場就報「有 1 筆未讀：你 → 小華，關於報告最終版」
- 她有個對話開著放著：訊息落地後幾十秒內，那個對話自己醒來說有新訊息
- 她想主動看：說「查信箱」

### 自動代答

如果訊息是純粹要資料（例如「報告放在哪」），小華的 Claude 會先驗證寄件人真的是你（看 Google Drive 記錄的檔案擁有者，不是看訊息裡自稱的名字），驗過之後可以直接把答案寫成回執寄回來；你的 Claude 收到回執也會叫醒你這邊。要小華本人做事、做決定的訊息，她的 Claude 不會代答，會等她本人。

## 四、怎麼安裝

### 前置需求（每臺機器都要）

| 項目 | 說明 |
|---|---|
| Claude Code | Mac 需 v2.1.224 以上、Windows 需 v2.1.234 以上（喚醒功能的版本門檻）。桌面版或終端機版都可以 |
| Node.js | 通知元件的腳本引擎。Mac：`brew install node` 或官網安裝器；Windows：官網 MSI 安裝器，安裝時保持「Add to PATH」勾選 |
| git | 安裝來源是 GitHub，Claude Code 會用 git 把這個 repo 抓下來。Mac 通常已內建（第一次用會跳出安裝命令列工具的提示，照裝即可）。**Windows 一律裝 [Git for Windows](https://git-scm.com/downloads/win) 官方安裝器，一路預設選項**。它附帶的 Git Bash 是通知元件在 Windows 上啟動時要用的東西，沒裝會在每次開對話時看到「找不到 sh」的錯誤 |
| Google Drive 桌面版 | 登入你自己的 Google 帳號、確認同步有在跑。Windows 版有「鏡像」與「串流」兩種模式，兩種都能用；我們實測過的是鏡像模式（檔案實際落在本機硬碟），串流模式沒實測，如果覺得訊息偵測變慢，可以在 Drive 設定切成鏡像 |

不需要 GitHub 帳號：這個 repo 是公開的，任何人都能直接下載安裝。

### Step 1：一個人當「房東」，建交換區

成員裡選一個人，在自己的 Google Drive（網頁版就可以）建一個資料夾 `_交換區`，裡面建這些子資料夾：每個成員一個 `收件匣-<名字>`、一個 `公告板`、一個 `議題`、一個 `封存`；再把這個 repo 裡的 `exchange-readme-template.md` 改名成 `README_交換區規約.md` 放進去（開頭那行設置註記照它說的處理）。

然後把 `_交換區` **分享給所有成員（權限：編輯者）**。每個成員在 Drive 網頁對它按右鍵 → 整理 → **新增捷徑到「我的雲端硬碟」**，這樣你電腦上的 Drive 桌面版才看得到它。

### Step 2：把這句話貼給你的 Claude

> 幫我安裝 a2a-mailbox 信箱系統：先跑 `claude plugin marketplace add https://github.com/a2a-mailbox/a2a-mailbox` 和 `claude plugin install mailbox-radar@a2a-mailbox --scope user`；然後把剛抓下來的 repo（在 `~/.claude/plugins/marketplaces/a2a-mailbox/`）裡 `skills/team-mailbox/` 的內容裝到 `~/.claude/skills/team-mailbox/`，照 config.md 裡的註解幫我把「名字」「交換區路徑」「白名單」三段填好（名字和白名單問我，交換區路徑你自己找）。裝完重開一個新對話。

**它會動到你機器上的什麼：** plugin 裝進 `~/.claude/plugins/`（Claude Code 的標準位置）；skill 與設定檔寫進 `~/.claude/skills/team-mailbox/`；之後運作時的狀態檔（心跳、log）寫在 plugin 的資料目錄。除此之外不碰你機器上任何東西。

**安裝過程它會問你什麼：** 你的名字（要跟交換區收件匣資料夾的後綴一致）、以及所有成員的名字＋Google email（白名單，驗寄件人身分用）。

**怎麼知道裝好了：** 重開新對話後，請 Claude 跑一次偵測器：

```
node ~/.claude/plugins/cache/a2a-mailbox/mailbox-radar/*/scripts/detect.mjs --pretty
```

看到 `"ok": true` 和你的名字就是通了。找人往你的收件匣丟一個測試訊息檔，開新對話有報未讀＝全通。

### （選配）終端機版的狀態列未讀數

只用桌面版的人跳過。CLI 使用者可以請 Claude 把 `statusline.mjs` 設進自己的 settings.json（指令寫在該檔開頭註解），狀態列會常駐顯示 📬 未讀數。

## 常見問題

| 現象 | 原因與處理 |
|---|---|
| Windows 開新對話出現 `Executable not found in $PATH: "sh"` 或「找不到 sh」 | 沒裝 Git for Windows。裝官方安裝器（預設選項）後重開對話即可。這只是通知元件的啟動方式找不到 Git Bash，訊息本身不會丟 |
| 安裝時 `marketplace add` 失敗，錯誤裡有 `Permission denied (publickey)` 或 `git@github.com` | 用了 `a2a-mailbox/a2a-mailbox` 這種簡寫，Claude Code 會預設走 SSH、而你的機器沒有 GitHub 的 SSH 金鑰。改用完整網址 `claude plugin marketplace add https://github.com/a2a-mailbox/a2a-mailbox` 就走 HTTPS，不需要任何帳號或金鑰 |
| 開新對話看到「通知器（watcher）心跳已超過 10 分鐘沒更新」 | 背景通知行程卡住了，這個版本會自動把它救回來；訊息不會漏，最多晚一點。持續出現再回報 |
| Claude 說「讀不到交換區」 | 照它給的提示查：Drive 桌面版沒在跑、路徑填錯、或（Mac）沒給完整磁碟取用權 |
| 寄了訊息對方一直沒反應 | 先確認對方裝了；再請對方開個新對話看有沒有報未讀。沒通知≠沒送到，訊息就在 Drive 上，不會消失 |
| 對方的 Claude 不肯自動回我的問題 | 多半是白名單沒把你的 email 填對（要填 Drive 檔案擁有者顯示的那個 Google 帳號） |

## 回饋

有問題或想改的地方，開一個 [GitHub Issue](https://github.com/a2a-mailbox/a2a-mailbox/issues)，或直接問你自己的 Claude（整套規約它讀得到）。歡迎提交修改建議（pull request）；是否合入由維護者決定。

## 授權

MIT，見 [LICENSE](LICENSE)。
