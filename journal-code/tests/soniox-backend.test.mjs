import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createJournalServer} from '../backend/server.mjs';

const workspaceId='11111111-1111-4111-8111-111111111111';
const permanentKey='server-only-soniox-test-key';
const temporaryKey='snx_temp_test-token.abc_DEF';
const now=Date.parse('2026-11-01T12:00:00Z');
const expiresAt=new Date(now+60000).toISOString();
async function setup(t,{sonioxKey=permanentKey,provider=()=>Response.json({api_key:temporaryKey,expires_at:expiresAt},{status:201}),clock=()=>now}={}){
 const calls=[],databaseCalls=[];
 const server=createJournalServer({url:'https://example.supabase.co',key:'sb_publishable_test',connection:{workspaceId,token:'a'.repeat(64)},sonioxKey,clock,fetcher:async(...args)=>{databaseCalls.push(args);throw Error('Voice must not call Supabase')},sonioxFetcher:async(url,opts)=>{calls.push({url,opts});return provider(url,opts)}});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
 const origin=`http://127.0.0.1:${server.address().port}`,headers={Origin:origin,'Content-Type':'application/json'};
 const session=(language='en-IN',options={})=>fetch(origin+'/api/voice/session',{method:'POST',headers,body:JSON.stringify({language}),...options});
 return {origin,headers,calls,databaseCalls,session};
}

test('voice session mints a restricted temporary key without returning the permanent key',async t=>{
 const s=await setup(t,{provider:()=>Response.json({api_key:temporaryKey,expires_at:expiresAt,secret:permanentKey},{status:201})});
 const response=await s.session();assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
 const data=await response.json();assert.equal(data.apiKey,temporaryKey);assert.equal(data.expiresAt,expiresAt);assert.equal(data.websocketUrl,'wss://stt-rt.soniox.com/transcribe-websocket');assert.equal(data.maxSessionSeconds,1800);
 assert.deepEqual(data.config,{model:'stt-rt-v5',audio_format:'auto',language_hints:['en'],enable_endpoint_detection:true});assert.equal(data.config.api_key,undefined);assert.equal(JSON.stringify(data).includes(permanentKey),false);
 assert.equal(s.calls[0].url,'https://api.soniox.com/v1/auth/temporary-api-key');assert.equal(s.calls[0].opts.headers.Authorization,`Bearer ${permanentKey}`);
 assert.deepEqual(JSON.parse(s.calls[0].opts.body),{usage_type:'transcribe_websocket',expires_in_seconds:60,single_use:true,max_session_duration_seconds:1800});
 assert.ok(s.calls[0].opts.signal instanceof AbortSignal);assert.equal(s.databaseCalls.length,0);
});
test('voice language choices map all five supported languages to Soniox hints',async t=>{
 const s=await setup(t);
 for(const [language,hint] of [['en-IN','en'],['ta-IN','ta'],['te-IN','te'],['ml-IN','ml'],['hi-IN','hi']]){
  const response=await s.session(language);assert.equal(response.status,200);assert.deepEqual((await response.json()).config.language_hints,[hint]);
 }
 assert.equal(s.calls.length,5);
});
test('unsupported and oversized requests are rejected before contacting Soniox',async t=>{
 const s=await setup(t);
 for(const language of ['fr-FR','en','',null,{}])assert.equal((await s.session(language)).status,422);
 assert.equal((await s.session('en-IN',{body:JSON.stringify({language:'en-IN',padding:'x'.repeat(1024)})})).status,413);
 assert.equal((await s.session('en-IN',{body:'[]'})).status,400);
 assert.equal(s.calls.length,0);
});
test('voice session keeps existing local origin and cross-site request guards',async t=>{
 const s=await setup(t);
 assert.equal((await s.session('en-IN',{headers:{...s.headers,Origin:'https://attacker.invalid'}})).status,403);
 assert.equal((await s.session('en-IN',{headers:{...s.headers,'Sec-Fetch-Site':'cross-site'}})).status,403);
 assert.equal((await s.session('en-IN',{headers:{'Content-Type':'application/json'}})).status,403);
 assert.equal(s.calls.length,0);
});
test('missing server key returns a configuration message without any provider call',async t=>{
 const s=await setup(t,{sonioxKey:''});const health=await (await fetch(s.origin+'/api/health')).json();assert.equal(health.voiceConfigured,false);
 const response=await s.session();assert.equal(response.status,503);assert.match((await response.json()).error,/SONIOX_API_KEY/);assert.equal(s.calls.length,0);
});
test('provider authentication, credit, capacity, and failure responses are safely mapped',async t=>{
 let status=401;const s=await setup(t,{provider:()=>Response.json({message:permanentKey},{status})});
 for(const [upstream,expected] of [[401,502],[403,502],[402,402],[429,429],[500,502]]){
  status=upstream;const response=await s.session();assert.equal(response.status,expected);assert.equal((await response.text()).includes(permanentKey),false);
 }
});
test('network and timeout failures return retryable errors and release the issuance lock',async t=>{
 let index=0;const s=await setup(t,{provider:()=>{index++;if(index===1)throw Error('network');if(index===2)throw new DOMException('Timed out','TimeoutError');return Response.json({api_key:temporaryKey,expires_at:expiresAt})}});
 assert.equal((await s.session()).status,503);assert.equal((await s.session()).status,503);assert.equal((await s.session()).status,200);
});
test('malformed, expired, permanent, and legacy provider keys never reach the client',async t=>{
 let result={};const s=await setup(t,{provider:()=>Response.json(result)});
 for(const candidate of [{},{api_key:permanentKey,expires_at:expiresAt},{api_key:temporaryKey,expires_at:'invalid'},{api_key:temporaryKey,expires_at:new Date(now-1000).toISOString()},{api_key:'temp:old-format',expires_at:expiresAt},{api_key:'snx_temp_bad key',expires_at:expiresAt}]){
  result=candidate;const response=await s.session();assert.equal(response.status,502);assert.equal((await response.text()).includes(candidate.api_key||permanentKey),false);
 }
});
test('issuance is capped at six per minute and resumes after the window',async t=>{
 let clock=now;const s=await setup(t,{clock:()=>clock,provider:()=>Response.json({api_key:temporaryKey,expires_at:new Date(clock+60000).toISOString()})});
 for(let i=0;i<6;i++)assert.equal((await s.session()).status,200);
 assert.equal((await s.session()).status,429);assert.equal(s.calls.length,6);
 clock+=60001;assert.equal((await s.session()).status,200);assert.equal(s.calls.length,7);
});
test('only one voice credential can be issued concurrently',async t=>{
 let release;const providerStarted=new Promise(resolve=>{release=resolve});let finish;
 const providerResult=new Promise(resolve=>{finish=()=>resolve(Response.json({api_key:temporaryKey,expires_at:expiresAt}))});
 const s=await setup(t,{provider:()=>{release();return providerResult}});const first=s.session();await providerStarted;
 assert.equal((await s.session()).status,429);assert.equal(s.calls.length,1);finish();assert.equal((await first).status,200);
});
