"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict"), crypto = require("node:crypto"), vm = require("node:vm");
require("../browser/core.js"); require("./core.js");
const dir = __dirname, rules=JSON.parse(fs.readFileSync(path.join(dir,"rules.json"),"utf8"));
const files=fs.readdirSync(path.join(dir,"synthetic_originals")).filter(n=>n.endsWith(".csv")).sort().map(name=>({name,text:fs.readFileSync(path.join(dir,"synthetic_originals",name),"utf8")}));
const truth=JSON.parse(fs.readFileSync(path.join(dir,"scenario_truth.json"),"utf8")), results=[];
function test(name,fn) { fn();results.push({name,status:"PASS"}); }
const result=AccountingDeid.transform(files,rules), issues=result.report.business_findings;
test("30 rows and original filenames, headers, column order, blank fields remain aligned",()=>{
  assert.equal(result.report.record_count,30);assert.equal(result.copies.length,3);
  for(let i=0;i<files.length;i++){
    const original=DeidCore.parseCSV(files[i].text), output=DeidCore.parseCSV(result.copies[i].content);
    assert.equal(result.copies[i].name,files[i].name);assert.equal(output.length,original.length);assert.deepEqual(output[0],original[0]);
    assert(output.every(r=>r.length===25));
    for(let row=1;row<original.length;row++) for(let col=0;col<25;col++) if(original[row][col]==="") assert.equal(output[row][col],"");
  }
});
test("Valid dates, amounts, tax, category and business status are preserved exactly",()=>{
  const kept=["date","received","period","type","category","currency","net","tax","total","tax_type","attachment","payment","reference_date","classification"];
  const after=AccountingDeid.decode(result.copies.map(f=>({name:f.name,text:f.content})),rules).records;
  result.records.forEach((r,i)=>{if(r.status!=="LOCAL_ONLY")for(const k of kept)assert.equal(after[i].data[k],r.data[k],k);});
});
test("All business findings remain identical when recomputed from pseudonymized CSV",()=>{
  const after=AccountingDeid.decode(result.copies.map(f=>({name:f.name,text:f.content})),rules).records;
  assert.deepEqual(AccountingDeid.business(after,rules),issues);
});
test("Planted accounting scenarios are detected independently of sanitizer output",()=>{
  for(const e of truth.examples)assert(issues.some(i=>i.file===e.file&&i.row===e.row&&i.code===e.expect),JSON.stringify(e));
  assert(!issues.some(i=>i.file===truth.valid_credit.file&&i.row===truth.valid_credit.row&&i.code.startsWith("CREDIT_")));
  assert(!issues.some(i=>i.file===truth.different_buyer_same_number.file&&i.row===truth.different_buyer_same_number.row&&/DUPLICATE|CONFLICT/.test(i.code)));
  assert(!issues.some(i=>i.file===truth.zero_amount.file&&i.row===truth.zero_amount.row&&/MISSING_(NET|TAX|TOTAL)|AMOUNT/.test(i.code)));
});
test("Privacy cases are exact: one unknown note plus health and private rows",()=>{
  assert.deepEqual(result.report.privacy_findings.map(({file,row,code})=>({file,row,code})),truth.privacy);
  assert.equal(result.report.local_only,2);
  const ordinary=result.records.filter(r=>r.status!=="LOCAL_ONLY");
  assert.equal(ordinary.filter(r=>r.output.includes("[備註待人工覆核]")).length,1);
  assert(result.copies.every(f=>!f.content.includes("[已遮蔽]")));
});
test("No declared identifiers or private prose enter the review bundle",()=>{
  const publicText=AccountingDeid.entries(result).map(e=>e.content).join("\n");
  for(const r of result.records) for(const k of Object.keys(rules.tokens)) if(r.data[k])assert(!publicText.includes(r.data[k]),k);
  for(const text of ["SYN-INV","虛構郭經理","SYN-EXT-88","虛構體檢報告","虛構家庭支出","identity_map","cell_changes"])assert(!publicText.includes(text),text);
  assert(!AccountingDeid.entries(result).some(e=>e.name.startsWith("PRIVATE")));
  assert(AccountingDeid.entries(result,true).some(e=>e.content.includes("虛構郭經理")));
});
test("Cross-file same document gets same token; credit references original",()=>{
  const data=AccountingDeid.decode(result.copies.map(f=>({name:f.name,text:f.content})),rules).records.map(r=>r.data);
  assert.equal(data[0].document,data[10].document);assert.equal(data[12].reference,data[14].document);
  assert.notEqual(data[0].document,data[20].document);
});
test("Exact decimal arithmetic handles negative fractions, zero and rejects unsafe forms",()=>{
  assert.equal(AccountingDeid.cents("-0.25"),-25n);assert.equal(AccountingDeid.cents("128.75"),12875n);
  assert.equal(AccountingDeid.cents("0"),0n);
  for(const v of ["1e5","12oops","1,000","=1+1","1.234","", " 12"])assert.equal(AccountingDeid.cents(v),null);
});
const altered=(field,value)=>{const m=DeidCore.parseCSV(files[0].text);m[1][m[0].indexOf(rules.fields[field][0])]=value;return [{name:"probe.csv",text:AccountingDeid.matrixCSV(m)}];};
test("Unknown text, formula payloads and unsafe numeric cells fail closed",()=>{
  for(const field of ["notes","category","net","date","period"]) {
    const output=AccountingDeid.transform(altered(field,'=HYPERLINK("https://example.invalid/private","虛構秘密")'),rules);
    assert(!AccountingDeid.entries(output).map(x=>x.content).join("").includes("HYPERLINK"));
    assert(output.report.privacy_findings.some(x=>x.row===2));
  }
});
test("Unknown classification stays local; unknown headers and unsafe filenames stop batch",()=>{
  const out=AccountingDeid.transform(altered("classification","未分類"),rules);
  assert.equal(out.records[0].status,"LOCAL_ONLY");
  assert.throws(()=>AccountingDeid.transform([{name:"../bad.csv",text:files[0].text}],rules));
  assert.throws(()=>AccountingDeid.transform([files[0],files[0]],rules));
  assert.throws(()=>AccountingDeid.transform([{name:"probe.csv",text:files[0].text.replace("客戶名稱","不明欄位")}],rules));
});
test("CSV quoting, embedded newline and Unicode preserve logical row alignment",()=>{
  const output=AccountingDeid.transform(altered("notes","例行月結\n發票影本待補"),rules);
  assert.equal(DeidCore.parseCSV(output.copies[0].content).length,11);
  assert.equal(output.records[0].output[23],"例行月結\n發票影本待補");
});
test("Regression: token-shaped input and numeric dates cannot bypass privacy review",()=>{
  for(const [field, value] of [["notes","請聯絡電話-1234567890"],["notes","請聯絡人員-001"],["date","1234567890"],["period","1234567"]]) {
    const output=AccountingDeid.transform(altered(field,value),rules);
    assert(output.report.privacy_findings.some(x=>x.row===2&&x.field===field));
    assert(!output.copies[0].content.includes(value));
  }
});
test("Regression: credit reference date mismatch requires review",()=>{
  const changed=files.map(f=>({...f})), matrix=DeidCore.parseCSV(changed[1].text);
  matrix[3][matrix[0].indexOf("折讓原單日期")]="2026-10-01";
  changed[1].text=AccountingDeid.matrixCSV(matrix);
  const output=AccountingDeid.transform(changed,rules);
  assert(output.report.business_findings.some(i=>i.file===1&&i.row===4&&i.code==="CREDIT_REFERENCE_DATE_MISMATCH"));
});
const html=fs.readFileSync(path.join(dir,"會計憑證本機去敏.html"),"utf8").replace(/\r\n/g,"\n");
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
test("Self-contained HTML has matching CSP hash and no external network resources",()=>{
  assert(html.includes("'sha256-"+crypto.createHash("sha256").update(script).digest("base64")+"'"));
  assert(html.includes("connect-src 'none'"));assert(!/<script[^>]+src=|<link[^>]+href=/i.test(html));
});
async function uiTest() {
  const nodes={};let downloads=0;
  function node(id) {
    return nodes[id] ||= {id,textContent:"",value:"0",disabled:true,checked:false,children:[],classList:{add(){},remove(){}},
      appendChild(child){this.children.push(child);return child;},replaceChildren(...children){this.children=children;},
      click(){downloads++;},remove(){}};
  }
  const context={document:{getElementById:node,createElement:()=>node("new"+Math.random()),body:node("body")},crypto:crypto.webcrypto,TextEncoder,TextDecoder,Uint8Array,DataView,Blob,URL,setTimeout};
  vm.createContext(context);vm.runInContext(script,context);
  assert.match(nodes.status.textContent,/程式已就緒/);nodes.demo.onclick();nodes.run.onclick();
  assert.match(nodes.summary.textContent,/30 筆/);assert.match(nodes["save-status"].textContent,/儲存去敏資料和還原檔/);
  nodes["ai-download"].onclick();assert.equal(downloads,1);
  nodes["map-download"].onclick();assert.equal(downloads,2);
  nodes.reset.onclick();assert(nodes.run.disabled);assert.equal(nodes["save-status"].textContent,"");
  const localFiles=files.map(f=>({name:f.name,size:Buffer.byteLength(f.text),arrayBuffer:async()=>Uint8Array.from(Buffer.from(f.text)).buffer}));
  await nodes.files.onchange({target:{files:localFiles}});
  nodes.run.onclick();assert.match(nodes.summary.textContent,/30 筆/);assert.match(nodes.status.textContent,/去敏完成/);
  results.push({name:"DOM simulation: ready, sample/file load, process, essential downloads, save reminder, reset",status:"PASS"});
}
(async()=>{
  await uiTest();
  const output=path.join(dir,"runs","verified");
  fs.mkdirSync(output,{recursive:true});
  for(const entry of [...AccountingDeid.entries(result),...AccountingDeid.entries(result,true)]) {
    const target=path.join(output,entry.name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,entry.content);
  }
  fs.writeFileSync(path.join(output,"會計去敏_本機覆核.zip"),DeidCore.zipStore(AccountingDeid.entries(result)));
  fs.writeFileSync(path.join(dir,"合成原始資料.zip"),DeidCore.zipStore(files.map(f=>({name:"原始資料/"+f.name,content:f.text}))));
  const sha=bytes=>crypto.createHash("sha256").update(bytes).digest("hex");
  const report={status:"PASS",checks:results,native_browser_tested:false,fixture:{files:3,rows:30,columns:25,ordinary_rows:28,local_only:2,unknown_notes:1},
    business_findings:issues.length,privacy_findings:result.report.privacy_findings.length,
    input_sha256:files.map(f=>({name:f.name,sha256:sha(Buffer.from(f.text))})),output_sha256:result.copies.map(f=>({name:f.name,sha256:sha(Buffer.from(f.content))})),
    html_sha256:sha(Buffer.from(html)),limitations:["Synthetic data only","Local review only; exact amounts, dates and filenames require approval","Native Chrome layout/download acceptance not performed"]};
  fs.writeFileSync(path.join(output,"validation.json"),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
