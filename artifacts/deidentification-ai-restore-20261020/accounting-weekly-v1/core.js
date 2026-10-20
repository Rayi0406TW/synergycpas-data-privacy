"use strict";
globalThis.AccountingDeid = (() => {
  const matrixCSV = rows => "\uFEFF" + rows.map(row => row.map(v => /[",\r\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v)).join(",")).join("\r\n") + "\r\n";
  const cents = value => /^-?\d{1,12}(?:\.\d{1,2})?$/.test(value) ? BigInt(value.split(".")[0]) * 100n + BigInt((value.startsWith("-") ? "-" : "") + ((value.split(".")[1] || "").padEnd(2, "0"))) : null;
  const dateOK = v => /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v + "T00:00:00Z")) && new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;
  const key = parts => JSON.stringify(parts);
  const party = (r, side) => r[side + "_id"] || r[side];
  const docKey = (r, reference = false) => key([party(r, "client"), party(r, "vendor"),
    (reference ? r.reference_date : r.date).slice(0, 4), reference ? r.reference : r.document]);
  const safeName = name => typeof name === "string" && name.length <= 120 && name.toLowerCase().endsWith(".csv") &&
    !/[\\/:*?"<>|\u0000-\u001f]/.test(name) && !/[. ]$/.test(name) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
  function decode(files, rules) {
    if (!files.length || files.length > 20) throw Error("請選取 1–20 個 CSV");
    if (files.reduce((n, f) => n + new TextEncoder().encode(f.text).length, 0) > 10000000) throw Error("批次上限 10 MB");
    const seen = new Set(), records = [], schemas = [];
    const aliases = new Map(Object.entries(rules.fields).flatMap(([k, names]) => names.map(n => [n, k])));
    files.forEach((f, fi) => {
      if (!safeName(f.name) || seen.has(f.name.normalize("NFC").toLowerCase())) throw Error("檔名不適用或重複；請在本機另存安全檔名");
      seen.add(f.name.normalize("NFC").toLowerCase());
      if (new TextEncoder().encode(f.text).length > 1000000) throw Error("單檔上限 1 MB");
      const rows = DeidCore.parseCSV(f.text), headers = rows[0], keys = headers.map(h => aliases.get(h));
      if (keys.some(k => !k) || new Set(keys).size !== keys.length || keys.length !== Object.keys(rules.fields).length) throw Error("第 " + (fi + 1) + " 檔欄位不符：需使用本版 25 欄，支援範例欄名與別名");
      schemas.push({name:f.name, headers, keys, rows});
      rows.slice(1).forEach((values, i) => {
        if (values.length !== headers.length) throw Error("第 " + (fi + 1) + " 檔第 " + (i + 2) + " 列欄數不符");
        records.push({file:fi, row:i + 2, raw:values, data:Object.fromEntries(keys.map((k, j) => [k, values[j]]))});
      });
    });
    if (records.length > 20000) throw Error("批次上限 20,000 列");
    return {schemas, records};
  }
  function business(records, rules) {
    const issues = [], add = (r, code) => issues.push({file:r.file, row:r.row, code});
    const active = records.filter(r => r.data.classification === "一般帳務");
    const docs = new Map();
    for (const r of active) {
      const d = r.data;
      for (const field of ["client_id", "vendor_id", "document", "date", "received", "period", "type", "category", "currency", "net", "tax", "total", "attachment", "payment"]) if (!d[field]) add(r, "MISSING_" + field.toUpperCase());
      for (const field of ["date", "received"]) if (d[field] && !dateOK(d[field])) add(r, "INVALID_" + field.toUpperCase());
      if (d.period && !/^\d{4}-(0[1-9]|1[0-2])$/.test(d.period)) add(r, "INVALID_PERIOD");
      if (dateOK(d.date) && d.date.slice(0, 7) !== d.period) add(r, "CROSS_PERIOD");
      if (dateOK(d.received) && dateOK(d.date) && d.received < d.date) add(r, "RECEIVED_BEFORE_ISSUE");
      if (d.period !== rules.period) add(r, "OUTSIDE_REVIEW_PERIOD");
      if (d.attachment && d.attachment !== "齊全") add(r, "ATTACHMENT_REQUIRED");
      const numbers = ["net", "tax", "total"].map(k => cents(d[k]));
      for (let i = 0; i < 3; i++) if (d[["net", "tax", "total"][i]] && numbers[i] === null) add(r, "INVALID_" + ["NET", "TAX", "TOTAL"][i]);
      if (numbers.every(n => n !== null) && numbers[0] + numbers[1] !== numbers[2]) add(r, "AMOUNT_SUM_MISMATCH");
      if (d.type === "折讓" && numbers.some(n => n !== null && n > 0n)) add(r, "CREDIT_SIGN_REVIEW");
      if (d.type !== "折讓" && numbers.some(n => n !== null && n < 0n)) add(r, "NEGATIVE_AMOUNT_REVIEW");
      if (d.document) { const k = docKey(d); if (!docs.has(k)) docs.set(k, []); docs.get(k).push(r); }
    }
    for (const group of docs.values()) if (group.length > 1) {
      const signature = r => key(["date", "type", "currency", "net", "tax", "total"].map(k => r.data[k]));
      const code = new Set(group.map(signature)).size > 1 ? "DOCUMENT_CONFLICT" : "DUPLICATE_VOUCHER";
      group.forEach(r => add(r, code));
    }
    for (const r of active.filter(r => r.data.type === "折讓")) {
      const d = r.data;
      if (!d.reference || !dateOK(d.reference_date)) { add(r, "CREDIT_REFERENCE_INCOMPLETE"); continue; }
      const matches = (docs.get(docKey(d, true)) || []).filter(x => x.data.type !== "折讓");
      if (!matches.length) add(r, "CREDIT_REFERENCE_NOT_IN_BATCH");
      else if (matches.length > 1) add(r, "CREDIT_REFERENCE_AMBIGUOUS");
      else {
        if (matches[0].data.date !== d.reference_date) add(r, "CREDIT_REFERENCE_DATE_MISMATCH");
        if (matches[0].data.currency !== d.currency) add(r, "CREDIT_CURRENCY_MISMATCH");
      }
    }
    // Names and identifiers are compared independently; conflicts are never silently merged.
    for (const side of ["client", "vendor"]) for (const [from, to] of [[side, side + "_id"], [side + "_id", side]]) {
      const groups = new Map();
      for (const r of active) if (r.data[from] && r.data[to]) { if (!groups.has(r.data[from])) groups.set(r.data[from], []); groups.get(r.data[from]).push(r); }
      for (const group of groups.values()) if (new Set(group.map(r => r.data[to])).size > 1) group.forEach(r => add(r, "IDENTITY_CONFLICT_" + side.toUpperCase()));
    }
    return Array.from(new Map(issues.map(i => [key([i.file, i.row, i.code]), i])).values()).sort((a,b) => a.file-b.file || a.row-b.row || a.code.localeCompare(b.code));
  }
  function transform(files, rules) {
    const {schemas, records} = decode(files, rules);
    const mappings = new Map(), identities = [], privacy = [], changes = [];
    const token = (namespace, raw) => {
      if (!raw) return "";
      if (!mappings.has(namespace)) mappings.set(namespace, new Map());
      const map = mappings.get(namespace);
      if (!map.has(raw)) {
        const value = namespace + "-" + String(map.size + 1).padStart(3, "0");
        map.set(raw, value); identities.push({namespace, original:raw, replacement:value});
      }
      return map.get(raw);
    };
    const eligible = records.filter(r => r.data.classification === "一般帳務");
    for (const r of eligible) for (const [field, namespace] of Object.entries(rules.tokens)) token(namespace, r.data[field]);
    // Replacement dictionaries contain declared identifiers only, not private-row content.
    const known = identities.slice().sort((a,b) => b.original.length - a.original.length);
    const flag = (r, field, code) => privacy.push({file:r.file, row:r.row, field, code});
    function notes(r) {
      let result = r.data.notes;
      if (!result) return "";
      // Use one regex pass: replacement text must not itself be replaced.
      const escaped = known.filter(x => x.original.length >= 2).map(x => x.original.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      const lookup = new Map(known.map(x => [x.original, x.replacement]));
      // Validate original text after removing only actual matched identifiers.
      // Never trust token-shaped text supplied by the input itself.
      let remainder = result;
      if (escaped.length) {
        const pattern = new RegExp(escaped.join("|"), "g");
        remainder = result.replace(pattern, "");
        result = result.replace(pattern, match => lookup.get(match));
      }
      for (const phrase of [...rules.safe_note_phrases].sort((a,b) => b.length-a.length)) remainder = remainder.split(phrase).join("");
      remainder = remainder.replace(/[\s，。；：、,;:()（）]/g, "");
      if (remainder) { flag(r, "notes", "FREE_TEXT_REVIEW"); return "[備註待人工覆核]"; }
      return result;
    }
    for (const r of records) {
      const d = r.data, out = {...d};
      if (rules.local_only.includes(d.classification) || d.classification !== "一般帳務") {
        r.output = schemas[r.file].keys.map((k, i) => i ? "" : "[本列僅限本機]");
        r.status = "LOCAL_ONLY"; flag(r, "classification", "LOCAL_ONLY");
      } else {
        for (const [field, namespace] of Object.entries(rules.tokens)) out[field] = token(namespace, d[field]);
        out.document = d.document ? token("憑證", docKey(d)) : "";
        out.reference = d.reference ? token("憑證", docKey(d, true)) : "";
        out.notes = notes(r);
        for (const [field, values] of Object.entries(rules.enums)) if (d[field] && !values.includes(d[field])) { out[field] = "[欄值待人工覆核]"; flag(r, field, "UNKNOWN_ENUM"); }
        for (const field of ["net", "tax", "total"]) if (d[field] && cents(d[field]) === null) { out[field] = "[數值待人工覆核]"; flag(r, field, "UNSAFE_AMOUNT"); }
        for (const field of ["date", "received", "reference_date"]) if (d[field] && !dateOK(d[field])) { out[field] = "[日期待人工覆核]"; flag(r, field, "UNSAFE_DATE"); }
        if (d.period && !/^\d{4}-(0[1-9]|1[0-2])$/.test(d.period)) { out.period = "[月份待人工覆核]"; flag(r, "period", "UNSAFE_PERIOD"); }
        r.output = schemas[r.file].keys.map(k => out[k]);
        r.status = privacy.some(p => p.file === r.file && p.row === r.row) ? "REVIEW_REQUIRED" : "PSEUDONYMIZED";
      }
      schemas[r.file].keys.forEach((k, j) => {
        if (r.raw[j] !== r.output[j]) changes.push({file:r.file, row:r.row, column:j+1, header:schemas[r.file].headers[j], before:r.raw[j], after:r.output[j]});
      });
    }
    const copies = schemas.map((s, i) => ({name:s.name, content:matrixCSV([s.headers, ...records.filter(r => r.file === i).map(r => r.output)])}));
    const findings = business(records, rules);
    const report = {version:rules.version, scope:"LOCAL_REVIEW_ONLY_NOT_APPROVED_FOR_AI", record_count:records.length,
      local_only:records.filter(r => r.status === "LOCAL_ONLY").length, privacy_findings:privacy, business_findings:findings,
      row_status:records.map(r => ({file:r.file, row:r.row, status:r.status})),
      file_index:schemas.map((s, i) => ({file:i, original_name:s.name, rows:s.rows.length-1})),
      filename_review_required:true, precision_data_review_required:true, token_scope:rules.token_scope};
    return {copies, report, changes, identities, records};
  }
  function entries(result, privateBundle = false) {
    if (privateBundle) return [
      {name:"PRIVATE/identity_map.json", content:JSON.stringify(result.identities, null, 2)},
      {name:"PRIVATE/cell_changes.json", content:JSON.stringify(result.changes, null, 2)}
    ];
    return [...result.copies.map(f => ({name:"去敏副本/" + f.name, content:f.content})),
      {name:"本機覆核結果.json", content:JSON.stringify(result.report, null, 2)}];
  }
  return Object.freeze({transform, decode, business, entries, matrixCSV, cents});
})();
