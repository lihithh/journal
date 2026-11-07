import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {readFileSync,statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const ROOT=path.resolve(fileURLToPath(new URL('../dist/',import.meta.url)));
const MAX_PHOTO_BYTES=2*1024*1024;
const MAX_BODY=9*1024*1024;
const VOICE_LANGUAGES=new Map([['en-IN','en'],['ta-IN','ta'],['te-IN','te'],['ml-IN','ml'],['hi-IN','hi']]);
const SONIOX_TEMP_KEY_URL='https://api.soniox.com/v1/auth/temporary-api-key';
const VOICE_SESSION_SECONDS=1800;
const allowedTypes={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json','.png':'image/png','.svg':'image/svg+xml'};
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const fail=(status,message)=>{throw Object.assign(Error(message),{status})};
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data))};

// This server is deliberately a personal, loopback-only application. Its private
// connection token authenticates only this Journal workspace, never an Auth user.
export function createJournalServer({url,key,connection,fetcher=fetch,secure=false,sonioxKey='',sonioxFetcher=fetch,clock=()=>Date.now()}={}){
 if(!url||!key)throw Error('Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in .env.');
 const origin=new URL(url);
 if(origin.protocol!=='https:'||origin.username||origin.password)throw Error('SUPABASE_URL must use HTTPS.');
 if(!uuid(connection?.workspaceId)||!/^[a-f0-9]{64}$/.test(connection?.token||''))throw Error('Configure the private Journal connection in .local/connection.json.');

 async function rpc(action,payload={}){
  let response;
  try{response=await fetcher(new URL('/rest/v1/rpc/journal_local_api',origin),{method:'POST',headers:{apikey:key,'Content-Type':'application/json'},body:JSON.stringify({p_secret:connection.token,p_action:action,p_payload:payload}),signal:AbortSignal.timeout(30000)})}
  catch{fail(503,'Supabase is unreachable. Your writing stays on this device and will retry automatically.')}
  const data=await response.json().catch(()=>null);
  if(!response.ok){
   if(data?.code==='28000'||response.status===401||response.status===403)fail(401,'The private Journal connection needs repair. Your writing remains on this device.');
   if(data?.code==='40001'||response.status===409)fail(409,'This page changed elsewhere. Your local copy is preserved.');
   if(data?.code==='22023')fail(422,'Supabase could not accept this entry. Check its date, text, and photos.');
   if(response.status===429)fail(429,'Supabase is busy. Your writing will retry automatically.');
   fail(502,'Supabase could not save this entry. Your local copy is preserved.');
  }
  if(data===null||typeof data!=='object')fail(502,'Supabase returned an invalid response. Your local copy is preserved.');
  return data;
 }

 // Only short-lived, single-use voice credentials leave the backend. These
 // limits bound key issuance, independently of the Journal database transport.
 let voiceInFlight=false,voiceAttempts=[];
 async function voiceSession(language){
  const hint=VOICE_LANGUAGES.get(language);
  if(!hint)fail(422,'Choose English, Tamil, Telugu, Malayalam, or Hindi for voice typing.');
  if(!sonioxKey)fail(503,'Voice typing is not configured. Add SONIOX_API_KEY to the local .env file and restart Journal.');
  const now=clock();voiceAttempts=voiceAttempts.filter(start=>start>now-60000);
  if(voiceInFlight)fail(429,'A voice session is already starting. Please wait a moment.');
  if(voiceAttempts.length>=6)fail(429,'Too many voice sessions started. Please wait a minute.');
  voiceAttempts.push(now);voiceInFlight=true;
  try{
   let response;
   try{response=await sonioxFetcher(SONIOX_TEMP_KEY_URL,{method:'POST',headers:{Authorization:`Bearer ${sonioxKey}`,'Content-Type':'application/json'},body:JSON.stringify({usage_type:'transcribe_websocket',expires_in_seconds:60,single_use:true,max_session_duration_seconds:VOICE_SESSION_SECONDS}),signal:AbortSignal.timeout(15000)})}
   catch{fail(503,'Soniox is unreachable. Please try voice typing again in a moment.');}
   const data=await response.json().catch(()=>null);
   if(!response.ok){
    if(response.status===401||response.status===403)fail(502,'Soniox could not authorize voice typing. Check the server API key and its temporary-key permission.');
    if(response.status===402)fail(402,'Soniox credits are exhausted. Add credits to continue voice typing.');
    if(response.status===429)fail(429,'Soniox is busy. Please try voice typing again shortly.');
    fail(502,'Soniox could not start voice typing. Please try again shortly.');
   }
   if(typeof data?.api_key==='string'&&data.api_key.startsWith('temp:'))fail(502,'Soniox returned an older temporary-key format. Update the Soniox account configuration to use current temporary keys.');
   if(typeof data?.api_key!=='string'||!/^snx_temp_[A-Za-z0-9._~-]+$/.test(data.api_key)||data.api_key===sonioxKey||typeof data.expires_at!=='string'||!Number.isFinite(Date.parse(data.expires_at))||Date.parse(data.expires_at)<=clock())fail(502,'Soniox returned an invalid voice session. Please try again.');
   return {apiKey:data.api_key,expiresAt:data.expires_at,websocketUrl:'wss://stt-rt.soniox.com/transcribe-websocket',config:{model:'stt-rt-v5',audio_format:'auto',language_hints:[hint],enable_endpoint_detection:true},maxSessionSeconds:VOICE_SESSION_SECONDS};
  }finally{voiceInFlight=false}
 }

 async function body(req,maxBytes=MAX_BODY){
  let size=0;const chunks=[];
  for await(const c of req){size+=c.length;if(size>maxBytes)fail(413,maxBytes===MAX_BODY?'Entry is too large. Use up to three photos of 2 MB each.':'Voice session request is too large.');chunks.push(c)}
  let p;try{p=JSON.parse(Buffer.concat(chunks).toString()||'{}')}catch{fail(400,'Invalid JSON.')}
  if(!p||typeof p!=='object'||Array.isArray(p))fail(400,'An entry object is required.');
  return p;
 }
 function validate(p,creating){
  if(typeof p.text!=='string'||p.text.length>20000)fail(422,'Journal text must contain at most 20,000 characters.');
  if(typeof p.title!=='string'||p.title.length>160)fail(422,'Title must be 160 characters or less.');
  if(typeof p.language!=='string'||p.language.length<1||p.language.length>35)fail(422,'Choose a valid language.');
  if(typeof p.mood!=='string'||p.mood.length>40)fail(422,'Mood must be 40 characters or less.');
  if(!Array.isArray(p.photos)||p.photos.length>3)fail(422,'An entry can have up to three photos.');
  const photos=p.photos.map(photo=>{
   if(!photo||typeof photo.src!=='string'||typeof photo.caption!=='string'||photo.caption.length>160)fail(422,'Each photo needs a caption of at most 160 characters.');
   const match=/^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(photo.src);
   if(!match||match[1].length%4!==0||Buffer.byteLength(match[1],'base64')>MAX_PHOTO_BYTES)fail(422,'Use JPEG, PNG, or WebP photos of 2 MB or less.');
   return {src:photo.src,caption:photo.caption};
  });
  const clean={title:p.title,text:p.text,language:p.language,mood:p.mood,photos};
  if(creating){
   if(typeof p.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(p.date)||!Number.isFinite(Date.parse(p.date+'T12:00:00Z'))||new Date(p.date+'T12:00:00Z').toISOString().slice(0,10)!==p.date||!uuid(p.requestId))fail(422,'A valid journal date and request ID are required.');
   clean.date=p.date;clean.requestId=p.requestId;
  }else{
   if(!Number.isInteger(p.expectedVersion)||p.expectedVersion<1||typeof p.expectedUpdatedAt!=='string'||!Number.isFinite(Date.parse(p.expectedUpdatedAt)))fail(422,'The saved version is required to avoid overwriting another copy.');
   clean.expectedVersion=p.expectedVersion;clean.expectedUpdatedAt=p.expectedUpdatedAt;
  }
  // Ownership and completion are intentionally not copied from client input.
  return clean;
 }
 function guard(req){
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))fail(403,'Journal is available only on this Mac.');
  const host=req.headers.host||'';
  if(!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host)||Number(host.match(/:(\d+)$/)?.[1]||80)>65535)fail(403,'Open Journal using its localhost address.');
  if(req.headers['sec-fetch-site']==='cross-site')fail(403,'A local same-origin request is required.');
  const expected=`${secure?'https':'http'}://${host}`;
  if(req.headers.origin&&req.headers.origin!==expected)fail(403,'A local same-origin request is required.');
  if(!['GET','HEAD'].includes(req.method)){
   if(req.headers.origin!==expected||!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))fail(403,'A same-origin JSON request is required.');
  }
 }

 return http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');
  try{
   guard(req);
   const target=new URL(req.url,'http://localhost'),route=target.pathname;
   if(route.startsWith('/api/')){
    if(route==='/api/health'&&req.method==='GET')return json(res,200,{ok:true,storage:'supabase',mode:'personal-local',scope:'all-entry-content',project:origin.hostname,completion:'device-only',voiceConfigured:!!sonioxKey});
    if(route==='/api/voice/session'&&req.method==='POST'){
     const p=await body(req,1024);return json(res,200,await voiceSession(p.language));
    }
    if(route==='/api/session'&&req.method==='GET'){
     const result=await rpc('session');
     if(result.workspace?.id!==connection.workspaceId)fail(502,'Journal connection does not match this workspace.');
     return json(res,200,{workspace:{id:result.workspace.id,name:result.workspace.name||'My Journal'}});
    }
    if(route==='/api/entries'&&req.method==='GET'){
     const after=target.searchParams.get('after');if(after&&!uuid(after))fail(400,'Invalid pagination cursor.');
     const result=await rpc('list',{after});return json(res,200,{entries:result.entries,next:result.next});
    }
    if(route==='/api/entries'&&req.method==='POST'){
     const result=await rpc('create',validate(await body(req),true));return json(res,201,{entry:result.entry});
    }
    if(route.startsWith('/api/entries/')&&req.method==='PATCH'){
     const id=route.split('/').at(-1);if(!uuid(id))fail(400,'Invalid entry ID.');
     const result=await rpc('update',{...validate(await body(req),false),id});return json(res,200,{entry:result.entry});
    }
    return json(res,404,{error:'Endpoint not available.'});
   }
   if(!['GET','HEAD'].includes(req.method))fail(405,'Method not allowed.');
   let name;try{name=decodeURIComponent(route==='/'?'/index.html':route)}catch{fail(400,'Invalid URL.')}
   const file=path.resolve(ROOT,'.'+name);
   if(!file.startsWith(ROOT+path.sep))fail(404,'Not found.');
   let bytes;try{bytes=await readFile(file)}catch{fail(404,'Not found.')}
   res.writeHead(200,{'Content-Type':allowedTypes[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache'});res.end(req.method==='HEAD'?undefined:bytes);
  }catch(e){json(res,e.status||500,{error:e.status?e.message:'Unexpected server error. Your local writing is preserved.'})}
 });
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
 const connectionFile=fileURLToPath(new URL('../.local/connection.json',import.meta.url));
 if(statSync(connectionFile).mode&0o077)throw Error('The Journal connection file must have owner-only permissions (chmod 600 .local/connection.json).');
 const connection=JSON.parse(readFileSync(connectionFile,'utf8'));
 const port=Number(process.env.PORT||3000),server=createJournalServer({url:process.env.SUPABASE_URL,key:process.env.SUPABASE_PUBLISHABLE_KEY,connection,sonioxKey:process.env.SONIOX_API_KEY||''});
 server.listen(port,'127.0.0.1',()=>console.log(`Journal: http://localhost:${port}\nSupabase: personal connection enabled · no browser login required.`));
}
