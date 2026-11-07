import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import http from 'node:http';
import {createJournalServer} from '../backend/server.mjs';

const wid='11111111-1111-4111-8111-111111111111',eid='22222222-2222-4222-8222-222222222222';
const token='a'.repeat(64);
const entry={entry_id:eid,workspace_id:wid,journal_date:'2026-11-01',title:'A day',journal_text:'Words',language:'en-IN',mood:'Good',photos:[],version:1,client_request_id:eid,created_at:'2026-11-01T00:00:00Z',updated_at:'2026-11-01T00:00:00Z'};
const content={title:'A day',text:'Words',language:'en-IN',mood:'Good',photos:[]};
async function setup(t,respond=({p_action})=>p_action==='session'?{workspace:{id:wid,name:'My Journal'}}:p_action==='list'?{entries:[entry],next:null}:{entry}){
 const calls=[];
 const server=createJournalServer({url:'https://example.supabase.co',key:'sb_publishable_test',connection:{workspaceId:wid,token},fetcher:async(url,opts)=>{
  const payload=JSON.parse(opts.body);calls.push({url:String(url),opts,payload});const result=await respond(payload);
  return result instanceof Response?result:Response.json(result);
 }});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));
 const origin=`http://127.0.0.1:${server.address().port}`;
 return {calls,origin,server,headers:{Origin:origin,'Content-Type':'application/json'}};
}

// The test transport has no cookies or user login: all authentication stays in
// the backend's workspace credential, while every upstream call still verifies it.
test('connects automatically without browser login or credential exposure',async t=>{
 const s=await setup(t);const response=await fetch(s.origin+'/api/session');assert.equal(response.status,200);
 assert.deepEqual(await response.json(),{workspace:{id:wid,name:'My Journal'}});assert.equal(response.headers.get('set-cookie'),null);
 assert.equal(s.calls[0].payload.p_secret,token);assert.equal(s.calls[0].url,'https://example.supabase.co/rest/v1/rpc/journal_local_api');
 assert.equal(s.calls[0].opts.headers.apikey,'sb_publishable_test');
 assert.equal((await fetch(s.origin+'/.env')).status,404);assert.equal((await fetch(s.origin+'/.local/connection.json')).status,404);
 const login=await fetch(s.origin+'/api/auth/sign-in',{method:'POST',headers:s.headers,body:'{}'});assert.equal(login.status,404);
});
test('all entry content round trips and completion and ownership are not sent',async t=>{
 const photos=[{src:'data:image/jpeg;base64,YWJj',caption:'A moment'}];let saved;
 const s=await setup(t,p=>{saved={...entry,title:p.p_payload.title,journal_text:p.p_payload.text,mood:p.p_payload.mood,photos:p.p_payload.photos};return {entry:saved}});
 const response=await fetch(s.origin+'/api/entries',{method:'POST',headers:s.headers,body:JSON.stringify({...content,photos,date:'2026-11-01',requestId:eid,completed:true,user_id:'attacker',workspace_id:'attacker'})});
 assert.equal(response.status,201);assert.deepEqual((await response.json()).entry.photos,photos);assert.equal(saved.mood,'Good');
 assert.equal(s.calls[0].payload.p_action,'create');for(const field of ['completed','completedAt','user_id','workspace_id'])assert.equal(s.calls[0].payload.p_payload[field],undefined);
 assert.equal(JSON.stringify(saved).includes(token),false);
});
test('title-only entries and clearing text are saved without completion',async t=>{
 const s=await setup(t);const create=await fetch(s.origin+'/api/entries',{method:'POST',headers:s.headers,body:JSON.stringify({...content,text:'',date:'2026-11-01',requestId:eid})});assert.equal(create.status,201);
 const update=await fetch(s.origin+'/api/entries/'+eid,{method:'PATCH',headers:s.headers,body:JSON.stringify({...content,title:'',text:'',expectedVersion:1,expectedUpdatedAt:entry.updated_at})});assert.equal(update.status,200);
 const sent=s.calls[1].payload;assert.equal(sent.p_action,'update');assert.equal(sent.p_payload.text,'');assert.equal(sent.p_payload.id,eid);assert.equal(sent.p_payload.expectedVersion,1);
});
test('lists entries and forwards validated pagination cursor',async t=>{
 const s=await setup(t);const response=await fetch(s.origin+'/api/entries?after='+eid);assert.equal(response.status,200);assert.deepEqual(await response.json(),{entries:[entry],next:null});assert.deepEqual(s.calls[0].payload.p_payload,{after:eid});
 assert.equal((await fetch(s.origin+'/api/entries?after=bad')).status,400);assert.equal(s.calls.length,1);
});
test('rejects cross-origin reads, writes, and cross-site browser requests',async t=>{
 const s=await setup(t);
 assert.equal((await fetch(s.origin+'/api/entries',{headers:{Origin:'https://attacker.invalid'}})).status,403);
 assert.equal((await fetch(s.origin+'/api/session',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
 assert.equal((await fetch(s.origin+'/api/entries',{method:'POST',headers:{...s.headers,Origin:'https://attacker.invalid'},body:'{}'})).status,403);
 assert.equal((await fetch(s.origin+'/api/entries',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
 assert.equal(s.calls.length,0);
});
test('rejects a non-local Host header to prevent DNS rebinding',async t=>{
 const s=await setup(t);const status=await new Promise((resolve,reject)=>{const req=http.get(s.origin+'/api/session',{headers:{Host:'attacker.invalid:3000'}},res=>{res.resume();resolve(res.statusCode)});req.on('error',reject)});assert.equal(status,403);assert.equal(s.calls.length,0);
});
test('validates date, size, photo payload, version, and JSON before RPC',async t=>{
 const s=await setup(t),valid={...content,date:'2026-11-01',requestId:eid};
 for(const patch of [{date:'2026-02-31'},{text:'x'.repeat(20001)},{photos:Array(4).fill({src:'data:image/png;base64,YWJj',caption:''})},{photos:[{src:'https://attacker.invalid/a.jpg',caption:''}]},{photos:[{src:'data:image/png;base64,YWJj',caption:'x'.repeat(161)}]},{mood:'x'.repeat(41)}]){
  assert.equal((await fetch(s.origin+'/api/entries',{method:'POST',headers:s.headers,body:JSON.stringify({...valid,...patch})})).status,422);
 }
 assert.equal((await fetch(s.origin+'/api/entries/'+eid,{method:'PATCH',headers:s.headers,body:JSON.stringify(content)})).status,422);
 assert.equal((await fetch(s.origin+'/api/entries',{method:'POST',headers:s.headers,body:'null'})).status,400);
 assert.equal(s.calls.length,0);
});
test('maps revoked connection, conflicts, validation, and offline errors without login prompts',async t=>{
 for(const [code,status] of [['28000',401],['40001',409],['22023',422]]){
  const s=await setup(t,()=>Response.json({code,message:'private upstream details'},{status:400}));const response=await fetch(s.origin+'/api/session');assert.equal(response.status,status);const text=await response.text();assert.equal(text.includes('private upstream details'),false);assert.equal(/sign.in|password/i.test(text),false);
 }
 const s=await setup(t,()=>{throw Error('network')});assert.equal((await fetch(s.origin+'/api/session')).status,503);
});
test('health reports scope without implying a live save or leaking credentials',async t=>{
 const s=await setup(t);const response=await fetch(s.origin+'/api/health');const result=await response.json();assert.equal(result.mode,'personal-local');assert.equal(result.scope,'all-entry-content');assert.equal(result.completion,'device-only');assert.equal(JSON.stringify(result).includes(token),false);assert.equal(s.calls.length,0);
});
test('server restart reconnects using the same private configuration without a cookie',async t=>{
 const first=await setup(t);assert.equal((await fetch(first.origin+'/api/session')).status,200);await new Promise(r=>first.server.close(r));
 const second=await setup(t);assert.equal((await fetch(second.origin+'/api/session')).status,200);assert.equal(second.calls[0].payload.p_secret,token);
});
