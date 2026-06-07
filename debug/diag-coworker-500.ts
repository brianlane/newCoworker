import { loadEnv, makeHostingerClient, resolveVpsIp } from "./_shared.ts";
loadEnv();
const BUSINESS_ID = process.argv[2] ?? "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const remote = `
set -uo pipefail
RB_URL=\$(grep -E '^ROWBOAT_BASE_URL=' /opt/chat-worker/.env | cut -d= -f2-)
RB_PID=\$(grep -E '^ROWBOAT_PROJECT_ID=' /opt/chat-worker/.env | cut -d= -f2-)
RB_TOK=\$(grep -E '^ROWBOAT_GATEWAY_TOKEN=' /opt/chat-worker/.env | cut -d= -f2-)
RB_URL=\${RB_URL:-http://rowboat:3000}
cat > /tmp/diag.js <<'JS_EOF'
(async()=>{
  const url=process.env.RB_URL.replace(/\\/$/,'')+"/api/v1/"+process.env.RB_PID+"/chat";
  const agents=["OwnerCoworker","Coworker"];
  for(const ag of agents){
    for(let i=0;i<2;i++){
      const body={messages:[{role:'user',content:'Hi'}],stream:false,startAgent:ag};
      const t0=Date.now();
      let r,txt;
      try{ r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+process.env.RB_TOK},body:JSON.stringify(body)}); txt=await r.text(); }
      catch(e){ console.log(ag+' rep'+i+' FETCH_ERR '+(e&&e.message||e)); continue; }
      const ms=Date.now()-t0;
      let reply='';
      try{ const j=JSON.parse(txt); const out=(j.turn&&j.turn.output)||[]; const a=out.find(function(m){return m&&m.role==='assistant'&&typeof m.content==='string'&&m.content;}); reply=a?a.content:''; }catch(e){}
      console.log(ag+' rep'+i+' HTTP_'+r.status+' '+ms+'ms reply="'+reply.slice(0,80).replace(/\\n/g,' ')+'" body='+(r.ok?'':txt.slice(0,120)));
    }
  }
})();
JS_EOF
docker cp /tmp/diag.js chat-worker:/tmp/diag.js >/dev/null
docker exec -e RB_URL="\$RB_URL" -e RB_PID="\$RB_PID" -e RB_TOK="\$RB_TOK" chat-worker node /tmp/diag.js || true
echo "===DONE==="
`;
const { getActiveVpsSshKeyForBusiness } = await import("../src/lib/db/vps-ssh-keys.ts");
const { sshExec } = await import("../src/lib/hostinger/ssh.ts");
const key = await getActiveVpsSshKeyForBusiness(BUSINESS_ID);
if (!key) throw new Error(`no active ssh key for business ${BUSINESS_ID}`);
const client = makeHostingerClient();
const ip = await resolveVpsIp(client, key);
const res = await sshExec({ host: ip, username: key.ssh_username || "root", privateKeyPem: key.private_key_pem, command: remote, timeoutMs: 3 * 60 * 1000, onStdout: (c) => process.stdout.write(c), onStderr: (c) => process.stderr.write(c) });
process.exit(res.exitCode === 0 ? 0 : 1);
