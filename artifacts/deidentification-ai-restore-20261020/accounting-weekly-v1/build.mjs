import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {createRequire} from "node:module";
import {createHash} from "node:crypto";
const dir = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const {Workbook} = await import(pathToFileURL(require.resolve("@oai/artifact-tool", {paths:[
  "C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules"
]})).href);
await import("../browser/core.js");
await import("./core.js");
const rules = JSON.parse(await fs.readFile(path.join(dir, "rules.json"), "utf8"));
const fields = Object.keys(rules.fields);
const clients = [
  ["合成青禾設計有限公司", "SYN-BUYER-A", "虛構林會計", "SYN-PHONE-A", "lin@example.invalid", "SYN-ACCOUNT-A"],
  ["合成海嶼商貿有限公司", "SYN-BUYER-B", "虛構陳專員", "SYN-PHONE-B", "chen@example.invalid", "SYN-ACCOUNT-B"],
  ["合成晨光維修有限公司", "SYN-BUYER-C", "虛構黃助理", "SYN-PHONE-C", "huang@example.invalid", "SYN-ACCOUNT-C"]
];
const vendors = [
  ["合成方格文具行", "SYN-SELLER-A", "文具用品"],
  ["合成雲端服務有限公司", "SYN-SELLER-B", "專業服務費"],
  ["合成東岸材料行", "SYN-SELLER-C", "進貨"],
  ["合成捷達運輸行", "SYN-SELLER-D", "差旅費"],
  ["合成安信設備行", "SYN-SELLER-E", "設備"]
];
const amounts = [12500, 890, 48000, 3600, 24000, 720, 18600, 5600, 9800, 3150,
  12500, 2400, 16800, 960, 32000, 6800, 4500, 1280, 7500, 22400,
  3200, 4800, 19000, 860, 12400, 5400, 36000, 2600, 14800, 6700];
const rows = amounts.map((amount, i) => {
  const c = clients[Math.floor(i/10)], v = vendors[i%vendors.length], date = "2026-10-" + String(i%15+1).padStart(2,"0");
  return {client:c[0], client_id:c[1], vendor:v[0], vendor_id:v[1], contact:c[2], phone:c[3], email:c[4], account:c[5],
    document:"SYN-INV-"+String(i+1).padStart(4,"0"), date, received:"2026-10-19", period:"2026-10",
    type:"發票", category:v[2], currency:"TWD", net:String(amount), tax:String(Math.round(amount/20)), total:String(amount+Math.round(amount/20)),
    tax_type:"應稅", attachment:"齊全", payment:i%3 ? "未付款" : "已付款", reference:"", reference_date:"",
    notes:"例行月結；請聯絡"+c[2], classification:"一般帳務"};
});
// Scenarios are deliberately retained as source errors; the sanitizer never repairs bookkeeping.
rows[1].attachment = "缺發票影本"; rows[1].notes = "發票影本待補";
rows[2].category = ""; rows[2].notes = "科目待確認";
rows[3].total = "3781"; rows[3].notes = "同號金額待核";
rows[4].date = "2026-09-30"; rows[4].notes = "跨月收到憑證";
rows[5] = {...rows[5], type:"收據", net:"720", tax:"0", total:"720", tax_type:"免稅", notes:"收據無稅額"};
rows[6].attachment = "缺驗收單"; rows[6].notes = "驗收單待補";
rows[7].tax = ""; rows[7].total = ""; rows[7].notes = "科目待確認";
rows[8] = {...rows[8], currency:"USD", net:"128.75", tax:"0", total:"128.75", tax_type:"待確認", notes:"外幣原幣金額"};
rows[9] = {...rows[0], notes:"收到重複掃描件"};
rows[10] = {...rows[0], received:"2026-10-20", notes:"收到重複掃描件"};
rows[11] = {...rows[2], net:"48100", tax:"2405", total:"50505", notes:"同號金額待核"};
rows[12] = {...rows[12], date:"2026-10-16", type:"折讓", net:"-1600", tax:"-80", total:"-1680",
  reference:rows[14].document, reference_date:rows[14].date, vendor:rows[14].vendor, vendor_id:rows[14].vendor_id, notes:"退回兩件商品"};
rows[13].attachment = "缺付款證明"; rows[13].notes = "付款證明待補";
rows[15].notes = "請聯絡"+clients[1][2]+"；帳號核對："+clients[1][5];
rows[16].notes = "收件窗口為虛構郭經理，分機 SYN-EXT-88，請週三下午回電"; // unknown free text
rows[17] = {...rows[17], type:"折讓", net:"-200", tax:"-10", total:"-210",
  reference:"SYN-INV-NOT-IN-BATCH", reference_date:"2026-09-01", notes:"原憑證待補"};
rows[18].payment = ""; rows[18].notes = "付款證明待補";
rows[19].client = rows[18].client + "（採購部）"; rows[19].notes = "核對買方資料";
rows[20].document = rows[0].document; // same number, different buyer: not a duplicate
rows[21] = {...rows[21], type:"折讓", net:"-500", tax:"-25", total:"-525",
  reference:"", reference_date:"", notes:"原憑證待補"};
rows[22].received = "2026-10-01"; // before issue date
rows[23] = {...rows[23], net:"0", tax:"0", total:"0", notes:"資料已補齊"};
rows[24].notes = "免稅項目待會計確認"; rows[24].tax_type = "免稅"; rows[24].tax = "0"; rows[24].total = rows[24].net;
rows[25].period = "2026-11"; rows[25].notes = "跨月收到憑證";
rows[26].net = "-36000"; rows[26].tax = "-1800"; rows[26].total = "-37800";
rows[27].notes = "請聯絡"+clients[2][2]+"；"+clients[2][4];
rows[28].classification = "健康"; rows[28].notes = "合成健康資料：虛構體檢報告，僅供排除測試";
rows[29].classification = "私人"; rows[29].notes = "合成私人資料：虛構家庭支出，僅供排除測試";
const names = ["01_進項憑證_第一批.csv", "02_進項憑證_補件批.csv", "03_進項憑證_第二批.csv"];
const samples = [];
await fs.mkdir(path.join(dir,"synthetic_originals"), {recursive:true});
for (let i=0; i<3; i++) {
  const order = i===1 ? [...fields.slice(8,18), ...fields.slice(0,8), ...fields.slice(18)] : fields;
  const matrix = [order.map(k => rules.fields[k][i===1 ? 1 : 0]), ...rows.slice(i*10, i*10+10).map(r => order.map(k => r[k]))];
  const workbook = Workbook.create(), sheet = workbook.worksheets.add("Synthetic");
  // Artifact Tool authors the matrix. CSV serialization preserves exact text, including deliberate blanks.
  const range = sheet.getRange("A1:Y11"); range.values = matrix; workbook.recalculate();
  const readback = range.values.map(row => row.map(value => value == null ? "" : String(value)));
  if (JSON.stringify(readback) !== JSON.stringify(matrix)) throw Error("ARTIFACT_MATRIX_READBACK_MISMATCH");
  const text = AccountingDeid.matrixCSV(readback);
  await fs.writeFile(path.join(dir,"synthetic_originals",names[i]), text);
  samples.push({name:names[i], text});
}
const truth = {
  synthetic:true, rows:30, files:3, columns:25,
  examples:[
    {file:0,row:2,expect:"DUPLICATE_VOUCHER"}, {file:0,row:3,expect:"ATTACHMENT_REQUIRED"},
    {file:0,row:4,expect:"DOCUMENT_CONFLICT"}, {file:0,row:4,expect:"MISSING_CATEGORY"},
    {file:0,row:5,expect:"AMOUNT_SUM_MISMATCH"}, {file:0,row:6,expect:"CROSS_PERIOD"},
    {file:0,row:9,expect:"MISSING_TAX"}, {file:1,row:9,expect:"CREDIT_REFERENCE_NOT_IN_BATCH"},
    {file:2,row:3,expect:"CREDIT_REFERENCE_INCOMPLETE"}, {file:2,row:4,expect:"RECEIVED_BEFORE_ISSUE"},
    {file:2,row:7,expect:"OUTSIDE_REVIEW_PERIOD"}, {file:2,row:8,expect:"NEGATIVE_AMOUNT_REVIEW"}
  ],
  privacy:[{file:1,row:8,code:"FREE_TEXT_REVIEW"}, {file:2,row:10,code:"LOCAL_ONLY"}, {file:2,row:11,code:"LOCAL_ONLY"}],
  valid_credit:{file:1,row:4}, different_buyer_same_number:{file:2,row:2}, zero_amount:{file:2,row:5}
};
await fs.writeFile(path.join(dir,"scenario_truth.json"), JSON.stringify(truth,null,2));
const json = v => JSON.stringify(v).replace(/</g,"\\u003c").replace(/>/g,"\\u003e").replace(/&/g,"\\u0026");
const shared = await fs.readFile(path.join(dir,"../browser/core.js"),"utf8");
const core = await fs.readFile(path.join(dir,"core.js"),"utf8");
const restore = await fs.readFile(path.join(dir,"restore.js"),"utf8");
const ui = await fs.readFile(path.join(dir,"ui.js"),"utf8");
const script = [shared, core, restore, "const CONFIG = "+json({rules,samples})+";", ui].join("\n").replace(/\r\n/g,"\n");
const hash = createHash("sha256").update(script).digest("base64");
const template = await fs.readFile(path.join(dir,"template.html"),"utf8");
await fs.writeFile(path.join(dir,"會計憑證本機去敏.html"), template.replace("{{CSP_HASH}}", hash).replace("{{SCRIPT}}", () => script));
console.log(JSON.stringify({generated_files:3,rows:rows.length,columns:fields.length,html:"會計憑證本機去敏.html"}));
