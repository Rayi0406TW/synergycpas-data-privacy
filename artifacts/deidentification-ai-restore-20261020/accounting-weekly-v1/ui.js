(() => {
  const el = id => document.getElementById(id);
  let selected = [], result = null, busy = false, generation = 0;
  let restoreMap = null, aiFile = null, restored = null;
  const say = text => {el("status").textContent = text;};
  function resetRestorePreview() {
    restored=null; el("restore-preview").replaceChildren(); el("restore-warnings").replaceChildren();
    el("restore-summary").textContent="尚未還原。"; el("restore-output").classList.add("hidden");
    el("restored-download").disabled=true;
  }
  function clearRestore() {
    restoreMap=null; aiFile=null; resetRestorePreview();
    el("restore-map-file").value=""; el("ai-file").value="";
    el("restore-map-status").textContent="尚未選取還原檔。";
    el("ai-file-status").textContent="尚未選取 AI 結果。";
  }
  function resetResult() { result=null; el("results").classList.add("hidden"); el("save-status").textContent=""; clearRestore(); }
  function controls() {
    for(const id of ["demo","files","reset","restore-map-file","ai-file"]) el(id).disabled=busy;
    el("run").disabled=busy||!selected.length; el("originals").disabled=busy||!selected.length;
    for(const id of ["ai-download","map-download"]) el(id).disabled=busy||!result;
    el("restore-run").disabled=busy||!restoreMap||!aiFile;
    el("restored-download").disabled=busy||!restored;
  }
  function select(files) { selected=files; resetResult(); el("selection").textContent=files.length ? files.map(f=>f.name).join("、") : "尚未載入。"; controls(); }
  function save(name, entries) {
    saveFile(name,DeidCore.zipStore(entries),"application/zip");
  }
  function saveFile(name, content, type) {
    const url=URL.createObjectURL(new Blob([content],{type})), a=document.createElement("a");
    a.href=url; a.download=name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  async function readLocal(file, limit) {
    if(!file || file.size>limit) throw Error("檔案不存在或超過大小上限");
    const bytes=new Uint8Array(await file.arrayBuffer());
    return {name:file.name,bytes,text:new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(bytes)};
  }
  function readMap(text) {
    try { return JSON.parse(text); }
    catch { throw Error("這不是可用的還原檔，請選擇先前按「儲存還原檔」取得的檔案。"); }
  }
  function cells(parent, values, changed=false) { const tr=document.createElement("tr"); values.forEach((v,i)=>{const td=document.createElement("td");td.textContent=String(v);if(changed&&i>1)td.className="changed";tr.appendChild(td);});parent.appendChild(tr); }
  try {
    el("demo").onclick=()=>{generation++;select(CONFIG.samples.map(f=>({...f,bytes:new TextEncoder().encode(f.text)})));say("已載入 30 筆合成資料，按「產生去敏資料」。");};
    el("reset").onclick=()=>{generation++;select([]);el("files").value="";say("本頁資料已清空。");};
    el("files").onchange=async event=>{
      const current=++generation; select([]); busy=true; controls();
      try {
        const files=Array.from(event.target.files || []);
        if(files.length>20||files.some(f=>f.size>1000000)||files.reduce((n,f)=>n+f.size,0)>10000000)throw Error("上限 20 檔、每檔 1 MB、合計 10 MB");
        const loaded=await Promise.all(files.map(f=>readLocal(f,1000000)));
        if(current===generation){select(loaded);say("已載入 "+loaded.length+" 檔；按「產生去敏資料」開始。");}
      } catch(e){if(current===generation)say("無法載入："+e.message);} finally {busy=false;controls();}
    };
    el("originals").onclick=()=>{
      try {save("原始資料_本機保留.zip",selected.map(f=>({name:"原始資料/"+f.name,bytes:f.bytes})));}
      catch(e){say("無法下載原檔："+e.message);}
    };
    el("run").onclick=()=>{
      resetResult(); busy=true;controls();
      try {
        result=AccountingDeid.transform(selected,CONFIG.rules);
        result.batch_id="B-"+globalThis.crypto.randomUUID();
        result.restoreMap=AccountingRestore.createMap(result.identities,result.batch_id);
        restoreMap=result.restoreMap;
        el("restore-map-status").textContent="已自動使用本次還原資料；請記得儲存還原檔。";
        const r=result.report;
        el("summary").textContent=`已處理 ${r.record_count} 筆資料；${r.record_count-r.local_only} 筆可供 AI 整理，${r.local_only} 筆私人或不適用資料未放入去敏檔。`;
        el("save-status").textContent="請分別按上方兩個按鈕，儲存去敏資料和還原檔。";
        el("results").classList.remove("hidden");say("去敏完成。請先儲存去敏資料和還原檔，再將去敏資料交給 AI。");
      } catch(e){resetResult();say("處理停止："+e.message);} finally{busy=false;controls();}
    };
    el("ai-download").onclick=()=>{
      if(!result)return;
      save("去敏資料_"+result.batch_id+".zip",AccountingRestore.aiEntries(result,result.batch_id));
      el("save-status").textContent="已開始下載去敏資料。請確認還原檔也已儲存，兩份檔案放在同一個資料夾。";
    };
    el("map-download").onclick=()=>{
      if(!result)return;
      saveFile("還原檔_"+result.batch_id+".json",JSON.stringify(result.restoreMap,null,2),"application/json;charset=utf-8");
      el("save-status").textContent="已開始下載還原檔。請確認去敏資料也已儲存；還原檔留在自己的電腦，不要交給 AI。";
    };
    el("restore-map-file").onchange=async event=>{
      restoreMap=null; resetRestorePreview(); busy=true;controls();
      el("restore-map-status").textContent="尚未選取還原檔。";
      try {
        const files=Array.from(event.target.files||[]); if(!files.length)return;
        const file=await readLocal(files[0],10000000), map=readMap(file.text);
        AccountingRestore.validateMap(map,map.batch_id);
        restoreMap=map; el("restore-map-status").textContent="還原檔已載入，可選擇 AI 結果檔案。";
        say("還原檔已載入，選取 AI 結果後按「還原資料」。");
      } catch(e){say("無法載入還原檔："+e.message);} finally{busy=false;controls();}
    };
    el("ai-file").onchange=async event=>{
      aiFile=null;resetRestorePreview();busy=true;controls();
      el("ai-file-status").textContent="尚未選取 AI 結果。";
      try {
        const files=Array.from(event.target.files||[]); if(!files.length)return;
        const file=await readLocal(files[0],10000000), batchId=AccountingRestore.batchIdFromCSV(file.text);
        aiFile={...file,batchId};el("ai-file-status").textContent=file.name+"；已讀取，可開始還原。";
        say("AI 結果已載入；列數、欄位與順序可與原檔不同。");
      } catch(e){say("無法載入 AI 結果："+e.message);} finally{busy=false;controls();}
    };
    el("restore-run").onclick=()=>{
      resetRestorePreview();
      try {
        if(!restoreMap||!aiFile)throw Error("請先選取同一次去敏時儲存的還原檔與 AI 結果");
        restored=AccountingRestore.restoreCSV(aiFile.text,restoreMap,aiFile.batchId);
        const before=DeidCore.parseCSV(aiFile.text), limit=100;
        restored.changes.filter(change=>change.row===1).forEach(change=>
          cells(el("restore-preview"),["1（欄名）",change.before,change.before,change.after],true));
        restored.rows.slice(1,limit+1).forEach((row,r)=>row.forEach((value,c)=>
          cells(el("restore-preview"),[r+2,restored.headers[c],before[r+1][c],value],before[r+1][c]!==value)));
        for(const issue of restored.unknownTokens)cells(el("restore-warnings"),[issue.row,restored.headers[issue.column-1],issue.token,"找不到完整代號；保留原樣，請人工確認"]);
        for(const issue of restored.unrestorable)cells(el("restore-warnings"),[issue.row,restored.headers[issue.column-1],issue.value,"原文未提供給 AI，無法由標記還原"]);
        el("restore-summary").textContent=`AI 結果 ${restored.rows.length-1} 筆、${restored.headers.length} 欄；還原 ${restored.changes.length} 格；${restored.unknownTokens.length} 個未知代號、${restored.unrestorable.length} 個不可還原標記。保留 AI 的列數、順序、欄位結構與計算值。`+
          (restored.rows.length>limit+1 ? "預覽前 100 筆；下載包含全部結果。" : "");
        el("restore-output").classList.remove("hidden");
        say(restored.unknownTokens.length||restored.unrestorable.length ? "已完成可辨識代號還原，請查看待確認項目；下載會保留這些未還原內容。" : "還原完成，請查看結果，再按「儲存還原結果」。");
      } catch(e){restored=null;say("還原停止："+e.message);} finally{controls();}
    };
    el("restored-download").onclick=()=>{
      if(!restored)return;
      const name=aiFile.name.replace(/\.csv$/i,"")+"_已還原.csv";
      saveFile(name,restored.content,"text/csv;charset=utf-8");
    };
    controls();say("程式已就緒。請選擇資料檔案，或按「用範例試試」。");
  } catch(e) {say("程式啟動失敗，請重新開啟本頁。");}
})();
