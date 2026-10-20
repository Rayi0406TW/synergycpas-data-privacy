"use strict";
// Execute the packaged page script with a minimal DOM. No browser acceptance claim.
const fs=require("node:fs"),path=require("node:path"),vm=require("node:vm"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const dir=__dirname,html=fs.readFileSync(path.join(dir,"會計憑證本機去敏.html"),"utf8");
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const ids=new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]));
const nodes={},downloads=[],urls=new Map(),checks=[];
function makeNode() {
  return {textContent:"",value:"0",disabled:true,checked:false,children:[],classList:{add(){},remove(){}},
    appendChild(child){this.children.push(child);return child;},replaceChildren(...children){this.children=children;},
    click(){downloads.push({name:this.download,blob:urls.get(this.href)});},remove(){}};
}
function node(id) {assert(ids.has(id),"UI references absent element: "+id);return nodes[id]||=(makeNode());}
const context={document:{getElementById:node,createElement:()=>makeNode(),body:makeNode()},crypto:crypto.webcrypto,
  TextEncoder,TextDecoder,Uint8Array,DataView,Blob,
  URL:{createObjectURL(blob){const url="blob:test-"+urls.size;urls.set(url,blob);return url;},revokeObjectURL(url){urls.delete(url);}},
  setTimeout(fn){fn();return 1;}};
vm.createContext(context);vm.runInContext(script,context);
const localFile=(name,bytes)=>({name,size:bytes.length,arrayBuffer:async()=>Uint8Array.from(bytes).buffer});
const change=async(id,file)=>node(id).onchange({target:{files:file?[file]:[]}});
function pass(name){checks.push({name,status:"PASS"});}
function unzipStored(bytes) {
  const entries=new Map();let offset=0;
  while(bytes.readUInt32LE(offset)===0x04034b50){
    const size=bytes.readUInt32LE(offset+18),nameLength=bytes.readUInt16LE(offset+26),extra=bytes.readUInt16LE(offset+28);
    const name=bytes.subarray(offset+30,offset+30+nameLength).toString("utf8"),start=offset+30+nameLength+extra;
    entries.set(name,bytes.subarray(start,start+size));offset=start+size;
  }
  return entries;
}
(async()=>{
  assert.match(node("status").textContent,/程式已就緒/);assert.equal(node("restore-run").disabled,true);
  node("demo").onclick();node("run").onclick();
  assert.match(node("summary").textContent,/30 筆/);assert.match(node("restore-map-status").textContent,/已自動使用本次還原資料/);
  assert.match(node("save-status").textContent,/儲存去敏資料和還原檔/);pass("Packaged page starts, transforms samples and creates a batch-bound map");

  node("map-download").onclick();
  assert.match(downloads.at(-1).name,/^還原檔_.*\.json$/);
  const map=JSON.parse(await downloads.at(-1).blob.text());
  assert.equal(map.entries.length,55);assert.equal(map.version,"accounting-restore-v1");
  node("ai-download").onclick();
  const aiArchive=unzipStored(Buffer.from(await downloads.at(-1).blob.arrayBuffer()));
  assert.equal(aiArchive.size,4);assert([...aiArchive.keys()].every(name=>!name.startsWith("PRIVATE")));
  for(const [name,bytes] of aiArchive)if(name.endsWith(".csv"))assert(bytes.toString("utf8").includes(map.batch_id));
  pass("Download controls export a valid map and separate batch-marked AI CSVs");

  const fixtureDir=path.join(dir,"runs","restore-test");
  const aiBytes=fs.readFileSync(path.join(fixtureDir,"ai_result.csv"));
  const mapBytes=fs.readFileSync(path.join(fixtureDir,"PRIVATE","identity_map.json"));
  await change("ai-file",localFile("AI.csv",aiBytes));node("restore-run").onclick();
  assert.match(node("status").textContent,/批次編號不符/);assert.equal(node("restored-download").disabled,true);
  pass("A result from another batch cannot use the current in-memory map");

  await change("restore-map-file",localFile("identity_map.json",mapBytes));node("restore-run").onclick();
  assert.match(node("restore-summary").textContent,/25 筆/);assert.match(node("restore-summary").textContent,/還原 209 格/);
  assert.equal(node("restore-preview").children.length,25*16);assert.equal(node("restore-warnings").children.length,1);
  node("restored-download").onclick();
  const downloaded=Buffer.from(await downloads.at(-1).blob.arrayBuffer());
  assert.deepEqual(downloaded,fs.readFileSync(path.join(fixtureDir,"restored_result.csv")));
  assert.equal(downloads.at(-1).name,"AI_已還原.csv");
  pass("File imports, merged-row preview, irreversible warning and restored download match core output");

  await change("ai-file",localFile("no-batch.csv",Buffer.from("欄位\r\n公司-001\r\n")));
  assert.equal(node("restore-run").disabled,true);assert.equal(node("restored-download").disabled,true);
  assert.equal(node("restore-preview").children.length,0);
  await change("restore-map-file",localFile("broken.json",Buffer.from("not a map")));
  assert.match(node("status").textContent,/這不是可用的還原檔/);
  assert(!/JSON|Unexpected|SyntaxError/.test(node("status").textContent));
  await change("ai-file",localFile("AI.csv",aiBytes));
  await change("restore-map-file",localFile("bad-map.json",Buffer.from("{}")));
  assert.equal(node("restore-run").disabled,true);assert.equal(node("restored-download").disabled,true);
  pass("Invalid replacement imports clear prior previews and disable stale downloads");

  const originals=fs.readdirSync(path.join(dir,"synthetic_originals")).filter(name=>name.endsWith(".csv")).sort();
  const source=fs.readFileSync(path.join(dir,"synthetic_originals",originals[0]));
  await change("files",localFile(originals[0],source));node("originals").onclick();
  const originalArchive=unzipStored(Buffer.from(await downloads.at(-1).blob.arrayBuffer()));
  assert.deepEqual(originalArchive.get("原始資料/"+originals[0]),source);
  // Removing BOM and changing CRLF tests that the backup does not reserialize text.
  const alternate=Buffer.from(source.toString("utf8").replace(/^\uFEFF/,"").replace(/\r\n/g,"\n"));
  await change("files",localFile("LF-no-BOM.csv",alternate));node("originals").onclick();
  const alternateArchive=unzipStored(Buffer.from(await downloads.at(-1).blob.arrayBuffer()));
  assert.deepEqual(alternateArchive.get("原始資料/LF-no-BOM.csv"),alternate);
  pass("Original download preserves exact input bytes including BOM and newline variants");

  const threeFiles=originals.map(name=>localFile(name,fs.readFileSync(path.join(dir,"synthetic_originals",name))));
  await node("files").onchange({target:{files:threeFiles}});
  assert(originals.every(name=>node("selection").textContent.includes(name)));
  assert.equal(node("run").disabled,false);
  node("run").onclick();
  assert.match(node("summary").textContent,/已處理 30 筆資料；28 筆可供 AI 整理，2 筆/);
  node("map-download").onclick();
  const sameSessionMapBytes=Buffer.from(await downloads.at(-1).blob.arrayBuffer());
  const sameSessionMap=JSON.parse(sameSessionMapBytes.toString("utf8"));
  const fixedBatch="SYNTHETIC-RESTORE-20261020-A";
  const sameSessionAi=aiBytes.toString("utf8").replaceAll(fixedBatch,sameSessionMap.batch_id);
  await change("restore-map-file",localFile("same-session-map.json",sameSessionMapBytes));
  await change("ai-file",localFile("same-session-ai.csv",Buffer.from(sameSessionAi)));
  assert.equal(node("restore-run").disabled,false);
  node("restore-run").onclick();
  assert.match(node("restore-summary").textContent,/AI 結果 25 筆、16 欄；還原 209 格/);
  node("restored-download").onclick();
  const expectedSameSession=fs.readFileSync(path.join(fixtureDir,"restored_result.csv"),"utf8").replaceAll(fixedBatch,sameSessionMap.batch_id);
  assert.deepEqual(Buffer.from(await downloads.at(-1).blob.arrayBuffer()),Buffer.from(expectedSameSession));
  pass("One-session multi-file selection, sanitization, matching-map import, AI import and restored download");

  node("reset").onclick();assert.equal(node("restore-run").disabled,true);assert.equal(node("restored-download").disabled,true);
  assert.equal(node("restore-preview").children.length,0);pass("Clear page removes both deidentification and restoration state");
  const report={status:"PASS",kind:"packaged_html_dom_simulation",checks,native_browser_tested:false,external_ai_called:false};
  fs.writeFileSync(path.join(fixtureDir,"ui-validation.json"),JSON.stringify(report,null,2));
  console.log(JSON.stringify({status:"PASS",checks:checks.length,native_browser_tested:false},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
