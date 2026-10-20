"use strict";
/* Pure local transformation. No DOM, network, storage, model or SDK. */
globalThis.DeidCore = (() => {
  const OUTPUT = ["record_id", "source_file", "source_row", "client_token",
    "case_token", "document_token", "document_type", "status", "missing_fields"];
  const encoder = new TextEncoder();
  function parseCSV(input) {
    const text = input.replace(/^\uFEFF/, "");
    if (!text) throw new Error("EMPTY_CSV");
    const rows = [];
    let row = [], field = "", quoted = false, closed = false, started = false;
    const pushField = () => {
      if (row.length >= 64) throw new Error("COLUMN_COUNT_LIMIT");
      if (field.length > 8192) throw new Error("CELL_LENGTH_LIMIT");
      if (rows.length === 0 && field.length > 128) throw new Error("HEADER_LENGTH_LIMIT");
      row.push(field); field = ""; closed = false;
    };
    const pushRow = () => {
      pushField();
      if (rows.length >= 10001) throw new Error("ROW_COUNT_LIMIT");
      if (rows.length === 0 && row.reduce((sum, cell) => sum + cell.length, 0) > 512) {
        throw new Error("HEADER_LENGTH_LIMIT");
      }
      rows.push(row); row = []; started = false;
    };
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else { quoted = false; closed = true; }
        } else field += ch;
        continue;
      }
      if (closed && ![",", "\r", "\n"].includes(ch)) throw new Error("CSV_AFTER_QUOTE");
      if (ch === '"') {
        if (field || closed) throw new Error("CSV_UNEXPECTED_QUOTE");
        quoted = true; started = true;
      } else if (ch === ",") {
        pushField(); started = true;
      } else if (ch === "\r" || ch === "\n") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        pushRow();
      } else { field += ch; started = true; }
    }
    if (quoted) throw new Error("CSV_UNCLOSED_QUOTE");
    if (started || row.length || field || closed) pushRow();
    return rows;
  }
  function csvText(rows, columns = OUTPUT) {
    const quote = value => {
      const s = String(value ?? "");
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return "\uFEFF" + [columns, ...rows.map(row => columns.map(key => row[key]))]
      .map(row => row.map(quote).join(",")).join("\n") + "\n";
  }
  function csvMatrix(rows, format) {
    const quote = value => /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
    return (format.bom ? "\uFEFF" : "") + rows.map(row => row.map(quote).join(",")).join(format.newline) +
      (format.trailing_newline ? format.newline : "");
  }
  function patternFlags(value) {
    const flags = [];
    if (/[\p{L}\p{N}_.+-]+@[\p{L}\p{N}_.-]+\.[A-Za-z]{2,}/u.test(value)) flags.push("EMAIL_PATTERN");
    if (/\b09\d{2}[- ]?\d{3}[- ]?\d{3}\b/.test(value)) flags.push("PHONE_PATTERN");
    if (/^[=+\-@]/.test(value.trimStart())) flags.push("FORMULA_PREFIX");
    return flags;
  }
  async function sha256(bytes, cryptoProvider) {
    if (!cryptoProvider?.subtle) throw new Error("SHA256_UNAVAILABLE");
    const result = await cryptoProvider.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(result), value => value.toString(16).padStart(2, "0")).join("");
  }
  function safeComponent(name) {
    return typeof name === "string" && name.length > 0 &&
      !/[<>:"/\\|?*\x00-\x1f\x7f]/.test(name) && !/[. ]$/.test(name) &&
      !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) &&
      encoder.encode(name).length <= 255;
  }
  async function transform(inputs, rules, cryptoProvider, batchId) {
    if (!inputs.length || inputs.length > 20) throw new Error("FILE_COUNT_LIMIT");
    if (JSON.stringify(rules.output_columns) !== JSON.stringify(OUTPUT)) throw new Error("INVALID_OUTPUT_SCHEMA");
    if (inputs.reduce((n, file) => n + file.bytes.byteLength, 0) > 10_000_000) throw new Error("TOTAL_SIZE_LIMIT");
    const fields = rules.fields, aliases = new Map();
    for (const [key, spec] of Object.entries(fields)) {
      for (const alias of spec.aliases) {
        if (aliases.has(alias)) throw new Error("AMBIGUOUS_RULE");
        aliases.set(alias, key);
      }
    }
    const expected = Object.keys(fields);
    const mappings = {client: new Map(), case: new Map(), document: new Map()};
    const identityMap = {client: [], case: [], document: []};
    function token(kind, parts) {
      const key = JSON.stringify(parts);
      if (!mappings[kind].has(key)) {
        const prefix = {client: "CLIENT", case: "CASE", document: "DOC"}[kind];
        const value = `${prefix}-${String(mappings[kind].size + 1).padStart(3, "0")}`;
        mappings[kind].set(key, value);
        identityMap[kind].push({original_key: parts, token: value});
      }
      return mappings[kind].get(key);
    }
    const ordered = [...inputs].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    if (ordered.some(file => !safeComponent(file.name))) throw new Error("UNSAFE_FILENAME");
    if (new Set(ordered.map(file => file.name.normalize("NFC").toLowerCase())).size !== ordered.length) throw new Error("DUPLICATE_FILENAME");
    const candidates = [], decisions = [], manifest = [], schemas = new Map();
    const counts = {input_rows: 0, candidate_rows: 0, blocked_rows: 0,
      local_only_rows: 0, blocked_files: 0, unreadable_files: 0};
    for (let fileIndex = 0; fileIndex < ordered.length; fileIndex++) {
      const file = ordered[fileIndex], fileId = `FILE-${String(fileIndex + 1).padStart(3, "0")}`;
      const fileHash = await sha256(file.bytes, cryptoProvider);
      let table, sourceText;
      try {
        if (!file.name.toLowerCase().endsWith(".csv")) throw new Error("CSV_ONLY");
        if (file.bytes.byteLength > 1_000_000) throw new Error("FILE_SIZE_LIMIT");
        sourceText = new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(file.bytes);
        table = parseCSV(sourceText);
        if (table.length > 10001) throw new Error("ROW_COUNT_LIMIT");
      } catch (error) {
        counts.blocked_files++; counts.unreadable_files++;
        manifest.push({file_id: fileId, original_name: file.name, sha256: fileHash,
          rows: null, header_errors: [error instanceof TypeError ? "INVALID_UTF8" : error.message]});
        continue;
      }
      const [header, ...rows] = table;
      counts.input_rows += rows.length;
      if (counts.input_rows > 20000) throw new Error("TOTAL_ROW_LIMIT");
      const keys = header.map(name => aliases.get(name));
      const errors = [];
      if (keys.includes(undefined)) errors.push("UNKNOWN_COLUMN");
      if (new Set(header).size !== header.length || new Set(keys).size !== keys.length) errors.push("DUPLICATE_COLUMN");
      if (expected.some(key => !keys.includes(key))) errors.push("MISSING_COLUMN");
      if (rows.some(row => row.length !== header.length)) errors.push("MALFORMED_ROW_WIDTH");
      if (errors.length) counts.blocked_files++;
      else schemas.set(fileId, {header, keys, format: {bom: sourceText.startsWith("\uFEFF"),
        newline: sourceText.includes("\r\n") ? "\r\n" : sourceText.includes("\r") ? "\r" : "\n",
        trailing_newline: /[\r\n]$/.test(sourceText)}});
      manifest.push({file_id: fileId, original_name: file.name, sha256: fileHash,
        rows: rows.length, header_errors: errors});
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        const values = rows[rowIndex];
        const recordId = `REC-${String(decisions.length + 1).padStart(3, "0")}`;
        const decision = {record_id: recordId, source_file: fileId, source_row: rowIndex + 2,
          input_header: header, input_values: values, reasons: [], output: null};
        decisions.push(decision);
        if (errors.length) {
          Object.assign(decision, {result: "BLOCKED", reasons: errors}); counts.blocked_rows++; continue;
        }
        const row = Object.fromEntries(keys.map((key, i) => [key, values[i]]));
        if (fields.classification.local_only.includes(row.classification)) {
          Object.assign(decision, {result: "LOCAL_ONLY", reasons: ["LOCAL_ONLY_CLASSIFICATION"]});
          counts.local_only_rows++; continue;
        }
        const issues = [], missing = [];
        if (!fields.classification.allowed.includes(row.classification)) issues.push("UNKNOWN_CLASSIFICATION");
        for (const key of ["client", "case", "document"]) {
          if (!row[key] || row[key] !== row[key].trim()) issues.push("MISSING_OR_AMBIGUOUS_KEY:" + key);
        }
        for (const [key, spec] of Object.entries(fields)) {
          if (spec.action !== "enum") continue;
          const value = row[key];
          if (value === "" && spec.allow_missing) missing.push(key);
          else if (!spec.allowed.includes(value)) issues.push("UNKNOWN_ENUM:" + key);
          issues.push(...patternFlags(value).map(flag => flag + ":" + key));
        }
        if (issues.length) {
          Object.assign(decision, {result: "BLOCKED", reasons: issues}); counts.blocked_rows++; continue;
        }
        const output = {
          record_id: recordId, source_file: fileId, source_row: rowIndex + 2,
          client_token: token("client", [row.client]),
          case_token: token("case", [row.client, row.case]),
          document_token: token("document", [row.client, row.case, row.document]),
          document_type: row.document_type, status: row.status, missing_fields: missing.join(",")
        };
        candidates.push(output);
        Object.assign(decision, {result: "PENDING_HUMAN_REVIEW", output,
          reasons: ["TOKENIZE_KEYS", "DROP_RESTRICTED_FIELDS", ...(missing.length ? ["PRESERVE_MISSING_VALUE"] : [])],
          masked_value_fields: expected.filter(key => fields[key].action === "drop")});
        counts.candidate_rows++;
      }
    }
    if (counts.input_rows !== counts.candidate_rows + counts.blocked_rows + counts.local_only_rows) throw new Error("ACCOUNTING_ERROR");
    const csv = csvText(candidates);
    const report = {
      batch_id: batchId, status: "PENDING_HUMAN_REVIEW", rules_version: rules.version,
      rules_sha256: await sha256(encoder.encode(JSON.stringify(rules)), cryptoProvider),
      rules_hash_format: "UTF-8 JSON.stringify of embedded rules",
      candidate_sha256: await sha256(encoder.encode(csv), cryptoProvider),
      counts, token_scope: "this_batch_only", approved_export_created: false,
      candidate_value_completeness: counts.unreadable_files ? "PARTIAL_UNREADABLE_FILES_ROWS_UNKNOWN" :
        counts.blocked_rows || counts.local_only_rows ? "PARTIAL_ROWS_EXCLUDED" : "ALL_PARSED_ROWS_INCLUDED"
    };
    const fileCopies = [], rowStatus = [], cellChanges = [];
    for (const source of manifest) {
      const schema = schemas.get(source.file_id);
      if (!schema) continue;
      const rows = decisions.filter(row => row.source_file === source.file_id);
      for (const row of rows) {
        const values = row.output ? schema.keys.map((key, column) => {
          const spec = fields[key];
          if (spec.action === "tokenize") return row.output[key + "_token"];
          if (spec.action === "drop") return row.input_values[column] === "" ? "" : "[已遮蔽]";
          return row.input_values[column];
        }) : schema.header.map((_, column) => column === 0 ?
          (row.result === "LOCAL_ONLY" ? "[本列僅限本機]" : "[本列已攔截]") : "");
        row.review_values = values;
        rowStatus.push({source_file: source.file_id, source_row: row.source_row,
          output_row: row.source_row, status: row.result, reasons: row.reasons});
        values.forEach((value, column) => {
          if (value === row.input_values[column]) return;
          cellChanges.push({source_file: source.file_id, original_name: source.original_name,
            source_row: row.source_row, source_column: column + 1, column_name: schema.header[column],
            before: row.input_values[column], after: value, status: row.result,
            rule: row.output ? fields[schema.keys[column]].action : "whole_row_redacted"});
        });
      }
      const content = csvMatrix([schema.header, ...rows.map(row => row.review_values)], schema.format);
      fileCopies.push({file_id: source.file_id, original_name: source.original_name,
        name: "去敏副本/" + source.original_name, content, rows: rows.length,
        candidate_rows: rows.filter(row => row.output).length,
        placeholder_rows: rows.filter(row => !row.output).length,
        sha256: await sha256(encoder.encode(content), cryptoProvider)});
    }
    report.export_format_version = "aligned-csv-v2";
    report.export_scope = "LOCAL_REVIEW_COPY_NOT_AI_READY";
    report.row_position_format = "CSV_LOGICAL_RECORD_NUMBER_INCLUDING_HEADER";
    report.review_copy_completeness = counts.unreadable_files ? "PARTIAL_UNREADABLE_FILES_ROW_COUNTS_UNKNOWN" :
      fileCopies.length < manifest.length ? "PARTIAL_FILES_WITHOUT_REVIEW_COPY" : "ALL_SOURCE_ROW_POSITIONS_PRESERVED";
    return {candidates, decisions, manifest, identityMap, csv, report, fileCopies, rowStatus, cellChanges};
  }
  function changesHtml(result) {
    const escape = value => String(value).replace(/[&<>"']/g, ch =>
      ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[ch]);
    const labels = {tokenize: "改為代號", drop: "依規則遮蔽", whole_row_redacted: "整列原值不輸出"};
    const body = result.cellChanges.map(item => "<tr>" + [item.original_name, item.source_row,
      item.source_column, item.column_name, item.before, item.after, labels[item.rule] || item.rule]
      .map(value => "<td>" + escape(value) + "</td>").join("") + "</tr>").join("");
    return '<!doctype html><html lang="zh-Hant"><meta charset="utf-8">' +
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">' +
      '<title>本機私有逐格差異</title><style>body{font:16px/1.5 sans-serif;margin:24px}table{border-collapse:collapse;width:100%}' +
      'th,td{border:1px solid #bbc;padding:8px;text-align:left;white-space:pre-wrap;overflow-wrap:anywhere}th{background:#eef}</style>' +
      '<h1>本機私有逐格差異</h1><p>含原始值，只留本機。僅列出有變動的儲存格；列號是 CSV 資料列序號（含標頭），不是文字檔實體行號。</p>' +
      '<p>欄位結構未通過的檔案不產生對照副本，請查看 source_manifest.json。</p>' +
      '<table><thead><tr><th>原檔名</th><th>來源列</th><th>來源欄</th><th>原欄名</th><th>原值</th><th>去敏值</th><th>規則</th></tr></thead><tbody>' +
      body + '</tbody></table></html>';
  }
  function exportEntries(result, privateBundle = false) {
    const json = value => JSON.stringify(value, null, 2) + "\n";
    if (!privateBundle) {
      const index = result.manifest.map(source => {
        const copy = result.fileCopies.find(file => file.file_id === source.file_id);
        return {source_file: source.file_id, original_name: source.original_name,
          output_path: copy ? copy.name : null, output_sha256: copy ? copy.sha256 : null,
          input_rows: source.rows, review_rows: copy ? copy.rows : 0,
          candidate_rows: copy ? copy.candidate_rows : 0, placeholder_rows: copy ? copy.placeholder_rows : 0,
          status: copy ? "LOCAL_REVIEW_COPY" : "NO_REVIEW_COPY", header_errors: source.header_errors};
      });
      const {candidate_sha256, ...report} = result.report;
      return [...result.fileCopies.map(file => ({name: file.name, content: file.content})),
        {name: "file_index.json", content: json(index)},
        {name: "row_status.json", content: json(result.rowStatus)},
        {name: "review_status.json", content: json({...report,
          filename_policy: "ORIGINAL_NAMES_LOCAL_REVIEW_ONLY", filenames_reviewed: false,
          outputs: result.fileCopies.map(file => ({path: file.name, rows: file.rows,
            candidate_rows: file.candidate_rows, placeholder_rows: file.placeholder_rows, sha256: file.sha256}))})}];
    }
    return [
      {name: "identity_map.json", content: json(result.identityMap)},
      {name: "source_manifest.json", content: json(result.manifest)},
      {name: "decisions.json", content: json(result.decisions)},
      {name: "cell_changes.json", content: json(result.cellChanges)},
      {name: "逐格差異.html", content: changesHtml(result)},
      {name: "batch_report.json", content: json(result.report)}
    ];
  }
  /* Small UTF-8 ZIP store writer with validated local filenames and paths. */
  function zipStore(entries) {
    const parts = [], central = [];
    let offset = 0, centralSize = 0;
    function crc32(bytes) {
      let crc = 0xffffffff;
      for (const value of bytes) {
        crc ^= value;
        for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
      }
      return (crc ^ 0xffffffff) >>> 0;
    }
    const archiveNames = new Set();
    for (const entry of entries) {
      const components = entry.name.split("/");
      const normalized = entry.name.normalize("NFC").toLowerCase();
      if (!components.every(safeComponent) || archiveNames.has(normalized)) throw new Error("UNSAFE_ARCHIVE_NAME");
      archiveNames.add(normalized);
      const name = encoder.encode(entry.name), data = entry.bytes === undefined ? encoder.encode(entry.content) : new Uint8Array(entry.bytes), crc = crc32(data);
      const local = new Uint8Array(30), lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true); lv.setUint16(12, 33, true);
      lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true); lv.setUint16(26, name.length, true);
      const head = new Uint8Array(46), cv = new DataView(head.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true); cv.setUint16(14, 33, true); cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true);
      parts.push(local, name, data); central.push(head, name);
      offset += local.length + name.length + data.length; centralSize += head.length + name.length;
    }
    const end = new Uint8Array(22), ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true); ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
    const all = [...parts, ...central, end], result = new Uint8Array(offset + centralSize + 22);
    let cursor = 0;
    for (const part of all) { result.set(part, cursor); cursor += part.length; }
    return result;
  }
  return Object.freeze({parseCSV, csvText, patternFlags, sha256, transform, exportEntries, zipStore});
})();
