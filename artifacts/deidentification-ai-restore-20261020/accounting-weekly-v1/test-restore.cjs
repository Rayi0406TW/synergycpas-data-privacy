"use strict";

// Synthetic AI-style results only. This script does not contact an AI service.
// The source fixtures are read-only; evidence is written to runs/restore-test.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
require("../browser/core.js");
require("./core.js");
require("./restore.js");

const dir = __dirname;
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const rules = JSON.parse(fs.readFileSync(path.join(dir, "rules.json"), "utf8"));
const sourceDir = path.join(dir, "synthetic_originals");
const files = fs.readdirSync(sourceDir).filter(name => name.endsWith(".csv")).sort().map(name => {
  const bytes = fs.readFileSync(path.join(sourceDir, name));
  return {name, text: bytes.toString("utf8"), bytes, sha256: sha256(bytes)};
});
const checks = [];
function test(name, fn) {
  try { fn(); checks.push({name, status: "PASS"}); }
  catch (error) { checks.push({name, status: "FAIL", error: error.message}); throw error; }
}

const batchId = "SYNTHETIC-RESTORE-20261020-A";
const transformed = AccountingDeid.transform(files, rules);
const pseudonyms = AccountingDeid.decode(transformed.copies.map(file => ({name: file.name, text: file.content})), rules).records;
const restoreMap = AccountingRestore.createMap(transformed.identities, batchId);
const asCSV = AccountingDeid.matrixCSV;
const restore = matrix => AccountingRestore.restoreCSV(asCSV(matrix), restoreMap, batchId);
const cloned = object => JSON.parse(JSON.stringify(object));
const lookup = new Map(restoreMap.entries.map(entry => [entry.token, entry.original]));

// Start with all eligible source rows. The simulated AI may delete, merge,
// change or reorder rows without returning any original row IDs.
const headers = ["處理結果", "客戶", "客戶統編", "交易對象", "聯絡人", "電話", "Email", "銀行帳號", "憑證號碼", "折讓原單號", "會計科目", "未稅金額", "稅額", "含稅金額", "備註", "批次編號"];
const aiFields = ["client", "client_id", "vendor", "contact", "phone", "email", "account", "document", "reference", "category", "net", "tax", "total", "notes"];
const deletedIndexes = new Set([5, 7, 9, 10]);
const aiRows = transformed.records.flatMap((record, index) => {
  if (record.status === "LOCAL_ONLY" || deletedIndexes.has(index)) return [];
  const data = {...pseudonyms[index].data};
  let action = "保留";
  if (index === 0) {
    const second = pseudonyms[5].data;
    for (const field of ["net", "tax", "total"]) {
      const value = AccountingDeid.cents(data[field]) + AccountingDeid.cents(second[field]);
      const sign = value < 0n ? "-" : "";
      const absolute = value < 0n ? -value : value;
      data[field] = sign + (absolute / 100n) + "." + String(absolute % 100n).padStart(2, "0");
    }
    data.document += "；" + second.document;
    data.notes = "AI 合併兩筆文具款項；保留兩個憑證代號";
    action = "合併兩列";
  }
  if (index === 2) {
    data.category = "進貨（AI 整理）";
    data.notes = "AI 新增的分類說明，\"保留標點\"\n及儲存格內換行";
    action = "修改科目及備註";
  }
  return [[action, ...aiFields.map(field => data[field]), batchId]];
}).reverse();
const first = pseudonyms[0].data, secondBuyer = pseudonyms[12].data;
aiRows.splice(2, 0, [
  "新增跨對象彙總", first.client + "、" + secondBuyer.client,
  first.client_id + "、" + secondBuyer.client_id, first.vendor + "、" + secondBuyer.vendor,
  first.contact + "、" + secondBuyer.contact, first.phone + "、" + secondBuyer.phone,
  first.email + "；" + secondBuyer.email, first.account + "；" + secondBuyer.account,
  first.document + "；" + secondBuyer.document, secondBuyer.reference,
  "AI 彙總", "10900.00", "545.00", "11445.00", "AI 新增列；同一格可以保留多個對象", batchId
]);
const aiMatrix = [headers, ...aiRows];
const aiText = asCSV(aiMatrix);
const aiEntries = AccountingRestore.aiEntries(transformed, batchId);
let restored;

test("Existing fixtures contain 3 files, 30 rows, 25 columns and 28 ordinary rows", () => {
  assert.equal(files.length, 3);
  assert.equal(transformed.records.length, 30);
  assert.equal(transformed.records.filter(record => record.status !== "LOCAL_ONLY").length, 28);
  assert(files.every(file => DeidCore.parseCSV(file.text).every(row => row.length === 25)));
});

test("Restore map binds a batch and decodes document keys to original voucher numbers", () => {
  assert.equal(restoreMap.version, "accounting-restore-v1");
  assert.equal(restoreMap.batch_id, batchId);
  assert.equal(restoreMap.entries.length, transformed.identities.length);
  assert.equal(restoreMap.entries.length, 55);
  for (const identity of transformed.identities) {
    const expected = identity.namespace === "憑證" ? JSON.parse(identity.original)[3] : identity.original;
    assert.equal(lookup.get(identity.replacement), expected);
  }
});

test("AI input export contains 28 ordinary rows with a batch column and no PRIVATE map", () => {
  const csvEntries = aiEntries.filter(entry => entry.name.endsWith(".csv"));
  assert.equal(csvEntries.length, 3);
  assert.equal(csvEntries.reduce((sum, entry) => sum + DeidCore.parseCSV(entry.content).length - 1, 0), 28);
  for (const entry of csvEntries) {
    const matrix = DeidCore.parseCSV(entry.content);
    assert(matrix.every(row => row.length === 26));
    assert.equal(matrix[0][25], "批次編號");
    assert.equal(AccountingRestore.batchIdFromCSV(entry.content), batchId);
    assert(!entry.content.includes("[本列僅限本機]"));
  }
  assert(!aiEntries.some(entry => /PRIVATE|identity_map/.test(entry.name)));
  assert(aiEntries.some(entry => entry.name.endsWith(".txt")));
});

test("All original sensitive fields round-trip from all eligible synthetic rows", () => {
  for (let index = 0; index < transformed.records.length; index++) {
    const record = transformed.records[index];
    if (record.status === "LOCAL_ONLY") continue;
    const sensitive = [...Object.keys(rules.tokens), "document", "reference"];
    const output = restore([sensitive, sensitive.map(field => pseudonyms[index].data[field])]);
    assert.deepEqual(output.rows[1], sensitive.map(field => record.data[field]));
    assert.deepEqual(output.unknownTokens, []);
  }
});

test("AI results can use changed columns and 25 rows after merging, deletions, edits and reordering", () => {
  assert.equal(aiRows.length, 25);
  assert.equal(AccountingRestore.batchIdFromCSV(aiText), batchId);
  restored = AccountingRestore.restoreCSV(aiText, restoreMap, batchId);
  assert.deepEqual(restored.headers, headers);
  assert.equal(restored.rows.length, 26);
  assert.deepEqual(restored.rows[0], headers);
  assert.equal(restored.rows[1][8], transformed.records[27].data.document);
  assert.equal(restored.rows[1][0], "保留");
  assert(!restored.rows.slice(1).some(row => row[8] === transformed.records[7].data.document));
  assert.equal(restored.rows.slice(1).filter(row => row[8] === transformed.records[0].data.document).length, 1);
  assert.deepEqual(DeidCore.parseCSV(restored.content), restored.rows);
  assert.deepEqual(restored.unknownTokens, []);
});

test("Merged row restores identifiers while preserving computed totals and multiple vouchers", () => {
  const row = restored.rows.find(row => row[0] === "合併兩列");
  assert(row);
  assert.equal(row[1], transformed.records[0].data.client);
  assert.equal(row[8], transformed.records[0].data.document + "；" + transformed.records[5].data.document);
  assert.deepEqual(row.slice(11, 14), ["13220.00", "625.00", "13845.00"]);
});

test("AI category edits, new prose, CSV quoting and embedded newlines survive restoration", () => {
  const row = restored.rows.find(row => row[0] === "修改科目及備註");
  const originalAI = aiRows.find(row => row[0] === "修改科目及備註");
  assert.equal(row[10], "進貨（AI 整理）");
  assert.equal(row[14], originalAI[14]);
  assert.equal(row[8], transformed.records[2].data.document);
});

test("New aggregate row restores multiple companies, IDs, people, phones, emails, accounts and vouchers", () => {
  const row = restored.rows.find(row => row[0] === "新增跨對象彙總");
  const a = transformed.records[0].data, b = transformed.records[12].data;
  assert.equal(row[1], a.client + "、" + b.client);
  assert.equal(row[2], a.client_id + "、" + b.client_id);
  assert.equal(row[3], a.vendor + "、" + b.vendor);
  assert.equal(row[4], a.contact + "、" + b.contact);
  assert.equal(row[5], a.phone + "、" + b.phone);
  assert.equal(row[6], a.email + "；" + b.email);
  assert.equal(row[7], a.account + "；" + b.account);
  assert.equal(row[8], a.document + "；" + b.document);
  assert.equal(row[9], b.reference);
  assert.deepEqual(row.slice(11, 14), ["10900.00", "545.00", "11445.00"]);
});

test("Credit notes restore original voucher references without altering negative amounts", () => {
  const credit = transformed.records[12].data;
  const row = restored.rows.find(row => row[8] === credit.document);
  assert(row);
  assert.equal(row[9], credit.reference);
  assert.deepEqual(row.slice(11, 14), ["-1600", "-80", "-1680"]);
  assert.equal(row[1], credit.client);
});

test("Same voucher number for different buyers uses distinct tokens and restores the correct buyer", () => {
  assert.notEqual(pseudonyms[0].data.document, pseudonyms[20].data.document);
  assert.equal(transformed.records[0].data.document, transformed.records[20].data.document);
  const output = restore([["買方", "憑證"],
    [pseudonyms[20].data.client, pseudonyms[20].data.document],
    [pseudonyms[0].data.client, pseudonyms[0].data.document]]);
  assert.deepEqual(output.rows[1], [transformed.records[20].data.client, transformed.records[20].data.document]);
  assert.deepEqual(output.rows[2], [transformed.records[0].data.client, transformed.records[0].data.document]);
});

test("Restoration preserves all AI numeric strings exactly and never recalculates them", () => {
  const values = ["000012.50", "-500.00", "0", "1e5", "12,345.67", "999999999999999999999999.99"];
  const output = restore([["數字", "對象"], ...values.map(value => [value, first.client])]);
  assert.deepEqual(output.rows.slice(1).map(row => row[0]), values);
  aiRows.forEach((row, index) => assert.deepEqual(restored.rows[index + 1].slice(11, 14), row.slice(11, 14)));
});

test("Unknown and extended tokens are retained; a known token prefix is not replaced", () => {
  const token = first.client;
  const extended = token + "0";
  const output = restore([["內容"], [token + "；公司-999999；" + extended]]);
  assert.equal(output.rows[1][0], transformed.records[0].data.client + "；公司-999999；" + extended);
  assert(output.unknownTokens.some(item => item.token === "公司-999999" && item.row === 2 && item.column === 1));
  assert(output.unknownTokens.some(item => item.token === extended && item.row === 2 && item.column === 1));
  assert(output.changes.some(item => item.row === 2 && item.column === 1 && item.before.includes(token)));
});

test("Pivot results restore tokens in headers and report unknown header tokens without changing totals", () => {
  const token = first.client;
  const input = [["月份", token, "公司-999999", "批次編號"], ["2026-10", "13220.00", "987.65", batchId]];
  const output = restore(input);
  assert.deepEqual(output.headers, ["月份", transformed.records[0].data.client, "公司-999999", "批次編號"]);
  assert.deepEqual(output.rows[0], output.headers);
  assert.deepEqual(output.rows[1], input[1]);
  assert.deepEqual(DeidCore.parseCSV(output.content), output.rows);
  assert(output.changes.some(item => item.row === 1 && item.column === 2 && item.before === token && item.after === transformed.records[0].data.client));
  assert(output.unknownTokens.some(item => item.token === "公司-999999" && item.row === 1 && item.column === 3));
});

test("Replacement uses one pass so restored text that looks like another token is not replaced again", () => {
  const map = AccountingRestore.createMap([
    {namespace: "公司", replacement: "公司-001", original: "人員-001"},
    {namespace: "人員", replacement: "人員-001", original: "虛構代理"}
  ], batchId);
  const output = AccountingRestore.restoreCSV(asCSV([["內容"], ["公司-001、人員-001"]]), map, batchId);
  assert.equal(output.rows[1][0], "人員-001、虛構代理");
});

test("Review and local-only markers remain unchanged and are reported as not reversible", () => {
  const markers = ["[備註待人工覆核]", "[欄值待人工覆核]", "[數值待人工覆核]", "[日期待人工覆核]", "[月份待人工覆核]", "[本列僅限本機]"];
  const output = restore([["內容"], ...markers.map(marker => [marker])]);
  assert.deepEqual(output.rows.slice(1).map(row => row[0]), markers);
  markers.forEach((marker, index) => assert(output.unrestorable.some(item => item.value === marker && item.row === index + 2 && item.column === 1)));
  assert(restored.unrestorable.some(item => item.value === "[備註待人工覆核]"));
});

test("Batch detection rejects missing, blank or mixed batch values and duplicate batch columns", () => {
  assert.throws(() => AccountingRestore.batchIdFromCSV(asCSV([["內容"], ["測試"]])));
  assert.throws(() => AccountingRestore.batchIdFromCSV(asCSV([["內容", "批次編號"], ["測試", ""]])));
  assert.throws(() => AccountingRestore.batchIdFromCSV(asCSV([["內容", "批次編號"], ["一", batchId], ["二", batchId + "-OTHER"]])));
  assert.throws(() => AccountingRestore.batchIdFromCSV(asCSV([["批次編號", "批次編號"], [batchId, batchId]])));
});

test("Wrong map batch and mismatched row batches stop restoration", () => {
  assert.throws(() => AccountingRestore.restoreCSV(aiText, restoreMap, batchId + "-OTHER"));
  const wrongMap = {...restoreMap, batch_id: batchId + "-OTHER"};
  assert.throws(() => AccountingRestore.restoreCSV(aiText, wrongMap, batchId));
  const mixed = cloned(aiMatrix);
  mixed[1][headers.indexOf("批次編號")] = batchId + "-OTHER";
  assert.throws(() => AccountingRestore.restoreCSV(asCSV(mixed), restoreMap, batchId));
});

test("Conflicting token maps are rejected before restoration can choose a wrong original", () => {
  const identity = transformed.identities[0];
  assert.throws(() => AccountingRestore.createMap([identity, {...identity, original: "另一個合成公司"}], batchId));
  const invalid = cloned(restoreMap);
  invalid.entries.push({...invalid.entries[0], original: "另一個合成公司"});
  assert.throws(() => AccountingRestore.restoreCSV(aiText, invalid, batchId));
});

test("All original source files remain byte-for-byte unchanged", () => {
  for (const file of files) {
    const after = fs.readFileSync(path.join(sourceDir, file.name));
    assert.deepEqual(after, file.bytes);
    assert.equal(sha256(after), file.sha256);
  }
});

const outputDir = path.join(dir, "runs", "restore-test");
fs.mkdirSync(path.join(outputDir, "PRIVATE"), {recursive: true});
fs.mkdirSync(path.join(outputDir, "去敏AI輸入"), {recursive: true});
fs.writeFileSync(path.join(outputDir, "ai_result.csv"), aiText, "utf8");
fs.writeFileSync(path.join(outputDir, "restored_result.csv"), restored.content, "utf8");
fs.writeFileSync(path.join(outputDir, "PRIVATE", "identity_map.json"), JSON.stringify(restoreMap, null, 2), "utf8");
for (const entry of aiEntries) {
  const destination = entry.name.endsWith(".csv") ? path.join(outputDir, "去敏AI輸入", path.basename(entry.name)) : path.join(outputDir, path.basename(entry.name));
  fs.writeFileSync(destination, entry.content, "utf8");
}
const warningMatrix = [["內容", "批次編號"], [first.client + "；公司-999999；" + first.client + "0", batchId], ["[備註待人工覆核]", batchId]];
fs.writeFileSync(path.join(outputDir, "ai_result_warnings.csv"), asCSV(warningMatrix), "utf8");
const report = {
  status: "PASS", test_kind: "simulated_ai_result_using_existing_synthetic_data", external_ai_called: false,
  batch_id: batchId, checks,
  fixture: {files: files.length, original_rows: transformed.records.length, original_columns: 25, eligible_rows: 28},
  simulated_ai: {result_rows: aiRows.length, merged_source_rows: 2, deleted_duplicate_rows: 2, deleted_other_rows: 1, added_summary_rows: 1, modified_category_and_note_rows: 1, reordered: true},
  restoration: {map_entries: restoreMap.entries.length, changed_cells: restored.changes.length, unknown_tokens: restored.unknownTokens.length, nonreversible_markers: restored.unrestorable.length},
  original_files: files.map(file => ({name: file.name, sha256_before: file.sha256, sha256_after: sha256(fs.readFileSync(path.join(sourceDir, file.name))), unchanged: true})),
  result_sha256: {ai_result: sha256(Buffer.from(aiText)), restored_result: sha256(Buffer.from(restored.content))},
  native_browser_tested: false,
  limitations: ["AI output is simulated locally; no external AI model was called", "Masked review markers contain no reversible original value", "A removed or edited token cannot be inferred from the remaining text"]
};
fs.writeFileSync(path.join(outputDir, "validation.json"), JSON.stringify(report, null, 2), "utf8");
fs.writeFileSync(path.join(outputDir, "試用說明.md"), "# 合成資料還原試用\n\n本目錄使用既有 3 份合成原檔，AI 回傳結果是本機模擬，沒有呼叫外部 AI。\n\n1. 在網頁選取 `PRIVATE/identity_map.json`。\n2. 匯入 `ai_result.csv`，可預覽 25 筆資料的敏感代號還原。\n3. 合併列、刪除重複列及指定列、科目與備註修改、重排、新增跨對象彙總均已包含。\n4. `restored_result.csv` 為預期結果；`validation.json` 保存測試項目及原檔前後 SHA-256。\n5. `ai_result_warnings.csv` 可試看未知代號及待人工覆核標記；不可還原的內容保持原值。\n\n`去敏AI輸入/` 內為一般帳務 28 筆的去敏 CSV，右側附同一批次編號；健康及私人 2 筆保留在原檔，不放入 AI 輸入。原檔仍位於 `../../synthetic_originals/`。\n", "utf8");
console.log(JSON.stringify({status: report.status, checks: checks.length, fixture_rows: 30, result_rows: aiRows.length, restored_changed_cells: restored.changes.length, output: outputDir}, null, 2));
