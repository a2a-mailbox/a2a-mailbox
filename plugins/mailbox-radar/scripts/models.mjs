// team-mailbox-radar · 模型註冊表（Phase 3 驗收條件明定的形狀）
//
// 本專案所有 LLM 呼叫都從這張表取模型——程式碼其他地方不得出現模型 id 字串。
// 是程式碼裡的常數表、不是設定檔（設定檔會跟程式碼漂）。
// 鍵沿用架構塊的節點 id。環境變數只能在候選清單裡挑，不得塞自由字串。

export const MODELS = {
  classifier: {
    // 預設用最高級（設計決策）：這是授權閘門，錯的方向不對稱——
    // 漏放（該 tier 2 判成 0）代價是 agent 代使用者做了沒同意的事，遠比多問一句貴。
    // 量體＝每封訊息一次呼叫，Opus 與 Sonnet 的成本差在這個量級可忽略。
    model: 'claude-opus-5',
    purpose: '請求分類器：對進來的訊息跑四判準，輸出授權等級與是否產待辦',
    candidates: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
    envVar: 'MAILBOX_RADAR_MODEL_CLASSIFIER',
  },
};

/** 取節點的模型 id。環境變數覆寫只在候選清單內生效，清單外的值忽略並沿用預設。 */
export function modelFor(nodeId) {
  const entry = MODELS[nodeId];
  if (!entry) throw new Error(`模型註冊表沒有節點 ${nodeId}`);
  const override = entry.envVar && process.env[entry.envVar];
  if (override && entry.candidates.includes(override)) return override;
  return entry.model;
}

/** 取節點的遞補順序：以 modelFor 的結果開頭，接候選清單其餘項（去重）。 */
export function candidatesFor(nodeId) {
  const entry = MODELS[nodeId];
  if (!entry) throw new Error(`模型註冊表沒有節點 ${nodeId}`);
  const first = modelFor(nodeId);
  return [first, ...entry.candidates.filter((m) => m !== first)];
}
