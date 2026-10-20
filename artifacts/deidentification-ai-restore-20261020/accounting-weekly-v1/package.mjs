// Package the existing synthetic fixtures without regenerating or rewriting them.
import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
const dir = path.dirname(fileURLToPath(import.meta.url));
const rules = JSON.parse(await fs.readFile(path.join(dir,"rules.json"),"utf8"));
const samples = [];
for (const name of (await fs.readdir(path.join(dir,"synthetic_originals"))).filter(n => n.endsWith(".csv")).sort()) {
  samples.push({name,text:await fs.readFile(path.join(dir,"synthetic_originals",name),"utf8")});
}
const config = JSON.stringify({rules,samples}).replace(/</g,"\\u003c").replace(/>/g,"\\u003e").replace(/&/g,"\\u0026");
const sources = await Promise.all(["../browser/core.js","core.js","restore.js"].map(name=>fs.readFile(path.join(dir,name),"utf8")));
const ui = await fs.readFile(path.join(dir,"ui.js"),"utf8");
const script = [...sources,"const CONFIG = "+config+";",ui].join("\n").replace(/\r\n/g,"\n");
const hash = createHash("sha256").update(script).digest("base64");
const template = await fs.readFile(path.join(dir,"template.html"),"utf8");
const html = template.replace("{{CSP_HASH}}",hash).replace("{{SCRIPT}}",()=>script);
await fs.writeFile(path.join(dir,"會計憑證本機去敏.html"),html);
console.log(JSON.stringify({status:"PACKAGED",samples:samples.length,html:"會計憑證本機去敏.html",originals_rewritten:false}));
