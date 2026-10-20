"use strict";
/* Restore identifiers by token, independently of AI row count, order or schema. */
globalThis.AccountingRestore = (() => {
  const VERSION = "accounting-restore-v1";
  const BATCH_COLUMN = "批次編號";
  const tokenShape = /^(公司|統編|人員|電話|信箱|帳戶|憑證)-\d{3,}$/;
  const batchShape = /^[A-Za-z0-9_-]{1,80}$/;
  const tokenPattern = /(?:公司|統編|人員|電話|信箱|帳戶|憑證)-[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*/g;
  const withheldPattern = /\[(?:本列僅限本機|備註待人工覆核|欄值待人工覆核|數值待人工覆核|日期待人工覆核|月份待人工覆核)\]/g;

  function validateMap(map, batchId) {
    if (!map || map.version !== VERSION || !batchShape.test(map.batch_id || "") || !Array.isArray(map.entries)) {
      throw Error("還原檔格式不符；請選擇先前按「儲存還原檔」取得的檔案");
    }
    if (map.batch_id !== batchId) throw Error("批次編號不符，請選擇產生這份 AI 資料時儲存的還原檔");
    const lookup = new Map();
    for (const entry of map.entries) {
      if (!entry || typeof entry.token !== "string" || !tokenShape.test(entry.token) ||
          entry.namespace !== entry.token.slice(0, entry.token.indexOf("-")) ||
          typeof entry.original !== "string" || !entry.original.length) throw Error("還原檔內有無效項目");
      if (lookup.has(entry.token) && lookup.get(entry.token) !== entry.original) throw Error("同一代號對應多個原值，請重新選擇還原檔");
      lookup.set(entry.token, entry.original);
    }
    return lookup;
  }

  function createMap(identities, batchId) {
    if (!Array.isArray(identities) || !batchShape.test(batchId || "")) throw Error("無法建立還原檔");
    const entries = identities.map(item => {
      let original = item.original;
      // Existing document identities use [buyer, seller, year, document number].
      // Only the document number belongs in the restored CSV cell.
      if (item.namespace === "憑證" && typeof original === "string" && original.startsWith("[")) {
        let parts;
        try { parts = JSON.parse(original); } catch { throw Error("憑證對照資料不完整"); }
        if (!Array.isArray(parts) || parts.length !== 4 || !parts.every(p => typeof p === "string")) throw Error("憑證對照資料不完整");
        original = parts[3];
      }
      return {namespace:item.namespace, token:item.replacement, original};
    });
    const map = {version:VERSION, batch_id:batchId, entries};
    validateMap(map, batchId);
    return map;
  }

  function parseResult(text) {
    if (typeof text !== "string" || new TextEncoder().encode(text).length > 10000000) throw Error("AI 結果需為 10 MB 以內的 UTF-8 CSV");
    const rows = DeidCore.parseCSV(text), headers = rows[0];
    if (rows.some(row => row.length !== headers.length)) throw Error("AI 結果 CSV 各列欄數不一致");
    return rows;
  }

  function batchIdFromCSV(text) {
    const rows = parseResult(text), positions = rows[0].flatMap((name, i) => name === BATCH_COLUMN ? [i] : []);
    if (positions.length !== 1) throw Error("AI 結果需保留一個「批次編號」欄，請使用下載包內的 AI 操作說明");
    if (rows.length < 2) throw Error("AI 結果沒有資料列，無法確認批次");
    const ids = rows.slice(1).map(row => row[positions[0]]);
    if (ids.some(id => !batchShape.test(id)) || new Set(ids).size !== 1) throw Error("AI 結果的批次編號空白、格式不符或混入其他批次");
    return ids[0];
  }

  function restoreCSV(text, map, batchId) {
    const lookup = validateMap(map, batchId), input = parseResult(text);
    if (input[0].includes(BATCH_COLUMN) && batchIdFromCSV(text) !== batchId) throw Error("AI 結果與還原檔的批次編號不符");
    const changes = [], unknownTokens = [], unrestorable = [];
    const rows = input.map((values, r) => values.map((value, c) => {
      if (input[0][c] === BATCH_COLUMN) return value;
      const position = {row:r+1, column:c+1};
      for (const match of value.matchAll(withheldPattern)) unrestorable.push({...position, value:match[0]});
      const after = value.replace(tokenPattern, (token, offset, source) => {
        // ASCII identifiers and longer tokens must never be partially restored.
        const before = source[offset-1] || "", next = source[offset+token.length] || "";
        if (/[A-Za-z0-9_-]/.test(before) || /[A-Za-z0-9_-]/.test(next)) return token;
        if (!lookup.has(token)) { unknownTokens.push({...position, token}); return token; }
        return lookup.get(token);
      });
      if (after !== value) changes.push({...position, before:value, after});
      return after;
    }));
    return {content:AccountingDeid.matrixCSV(rows), headers:rows[0], rows, changes, unknownTokens, unrestorable};
  }

  function aiEntries(result, batchId) {
    if (!batchShape.test(batchId || "")) throw Error("批次編號格式不符");
    const entries = result.copies.map((copy, file) => {
      const rows = DeidCore.parseCSV(copy.content);
      const allowed = result.records.filter(record => record.file === file && record.status !== "LOCAL_ONLY");
      return {name:"去敏資料/"+copy.name, content:AccountingDeid.matrixCSV([
        [...rows[0], BATCH_COLUMN], ...allowed.map(record => [...record.output, batchId])
      ])};
    });
    entries.push({name:"AI操作說明.txt", content:[
      "本包是合成資料的小樣本，批次編號："+batchId,
      "請依使用者指定的工作計算或整理 CSV。可合併、刪除、新增、重排資料列，以及修改科目、金額或說明。",
      "回傳 UTF-8 CSV。可自行安排結果欄位，但每一列都必須保留「批次編號」欄且值完全相同。",
      "公司-001、人員-001、憑證-001 等代號請完整保留，不改寫、縮寫或猜測原值。",
      "一列涉及多個對象時，保留全部代號，例如：公司-001；公司-002。",
      "只剩「全部客戶」而沒有代號時，工具無法還原對象。遮蔽或待人工覆核標記也不能反推原文。",
      "不要附 Markdown 程式碼圍欄。還原檔由使用者留在自己的電腦，不提供給 AI。",
      "計算完成後，由使用者將 CSV 匯入本機網頁，再選擇當時儲存的還原檔還原。"
    ].join("\r\n")});
    return entries;
  }

  return Object.freeze({createMap, validateMap, batchIdFromCSV, restoreCSV, aiEntries});
})();
