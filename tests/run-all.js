const {execFileSync}=require('child_process');
const fs=require('fs'),path=require('path');
const dir=__dirname;
const files=fs.readdirSync(dir).filter(f=>f.endsWith('.test.js')).sort();
let fail=0;
for(const f of files){
  console.log('\n' + '═'.repeat(60) + '\n▶ ' + f + '\n' + '═'.repeat(60));
  try{ console.log(execFileSync('node',[path.join(dir,f)],{encoding:'utf8'})); }
  catch(e){ fail++; console.log(e.stdout||''); console.error(e.stderr||''); }
}
console.log('\n' + (fail? `❌ ${fail}/${files.length} 個測試檔失敗` : `✅ ${files.length} 個測試檔全部通過`));
process.exit(fail?1:0);
