import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import vm from 'node:vm';

const source=await readFile(new URL('../dist/cloud.js',import.meta.url),'utf8');
const workspace={id:'11111111-1111-4111-8111-111111111111',name:'My Journal'};
const today='2026-11-01';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}};
const copy=value=>structuredClone(value);
function row(content={}){
 return {entry_id:randomUUID(),client_request_id:randomUUID(),workspace_id:workspace.id,journal_date:today,title:'A title',journal_text:'Original words',language:'en-IN',mood:'',photos:[],version:1,created_at:'2026-11-01T01:00:00.000Z',updated_at:'2026-11-01T01:00:00.000Z',...content};
}

// The fake backend exposes the same public API contract. Its unique request IDs
// model database idempotency, and deferred hooks model actual network boundaries.
function browser({rows=[]}={}){
 const remote=new Map(rows.map(r=>[r.entry_id,copy(r)]));
 const calls=[],writes=[],listeners=new Map(),documentListeners=new Map(),timers=new Map();
 const hooks={};let nextTimer=0;
 const fields=new Map();
 function field(id){if(!fields.has(id))fields.set(id,{id,value:'',textContent:'',title:'',selectionStart:0,selectionEnd:0,focus(){document.activeElement=this},setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end}});return fields.get(id)}
 const document={documentElement:{dataset:{}},activeElement:null,hidden:false,addEventListener(name,fn){documentListeners.set(name,fn)}};
 const ready=deferred();
 const window={journalReady:ready.promise,addEventListener(name,fn){listeners.set(name,fn)}};
 const state={entries:{},selected:today,persistOk:true,historyOpen:false};
 const current=()=>state.entries[state.selected];
 function captureEditor(){
  const title=field('title').value,text=field('body').value,language=field('language').value||'en-IN';
  if(!current()&&!title.trim()&&!text.trim())return;
  const entry=state.entries[state.selected]??={date:state.selected,title:'',text:'',language:'en-IN',mood:'',photos:[],completed:false};
  if(entry.title!==title||entry.text!==text||entry.language!==language){Object.assign(entry,{title,text,language});entry.localRevision=(entry.localRevision||0)+1}
 }
 function render(){const e=current();field('title').value=e?.title||'';field('body').value=e?.text||'';field('language').value=e?.language||'en-IN'}
 async function writeStore(key,value){writes.push({key,value:copy(value)})}
 async function save(){captureEditor();await writeStore('entries',state.entries)}
 const fetcher=async(url,options={})=>{
  const method=options.method||'GET',payload=options.body?JSON.parse(options.body):null;
  const call={url,method,payload};calls.push(call);
  await hooks.before?.(call);
  let data,status=200;
  if(url==='/api/session')data={workspace};
  else if(url.startsWith('/api/entries')&&method==='GET')data={entries:[...remote.values()].map(copy),next:null};
  else if(url==='/api/entries'&&method==='POST'){
   let existing=[...remote.values()].find(r=>r.client_request_id===payload.requestId);
   if(!existing&&[...remote.values()].some(r=>r.journal_date===payload.date)){status=409;data={error:'Date already exists'}}
   else{
    existing??=row({journal_date:payload.date,client_request_id:payload.requestId,title:payload.title,journal_text:payload.text,language:payload.language,mood:payload.mood,photos:copy(payload.photos)});
    remote.set(existing.entry_id,existing);data={entry:copy(existing)};
   }
  }else if(url.startsWith('/api/entries/')&&method==='PATCH'){
   const existing=remote.get(url.split('/').at(-1));
   if(!existing||existing.version!==payload.expectedVersion||existing.updated_at!==payload.expectedUpdatedAt){status=409;data={error:'Version conflict'}}
   else{
    Object.assign(existing,{title:payload.title,journal_text:payload.text,language:payload.language,mood:payload.mood,photos:copy(payload.photos),version:existing.version+1,updated_at:`2026-11-01T01:00:${String(existing.version+1).padStart(2,'0')}.000Z`});data={entry:copy(existing)};
   }
  }else throw Error(`Unexpected request: ${method} ${url}`);
  await hooks.after?.(call,data);
  return Response.json(data,{status});
 };
 const context=vm.createContext({window,document,navigator:{onLine:true},get entries(){return state.entries},set entries(v){state.entries=v},get selected(){return state.selected},persistOk:true,historyOpen:false,$:field,current,captureEditor,save,writeStore,render,renderHistory(){},toast(){},fetch:fetcher,AbortSignal,crypto:{randomUUID},setTimeout(fn,delay){const id=++nextTimer;timers.set(id,{fn,delay});return id},clearTimeout(id){timers.delete(id)},setInterval(){},console});
 vm.runInContext(source,context,{filename:'cloud.js'});
 const api=window.JournalCloud;
 return {
  state,remote,calls,writes,hooks,field,api,document,
  async start(){ready.resolve();await Promise.resolve();await api.flush()},
  async flush(){await api.flush()},
  type({title=field('title').value,text=field('body').value,language=field('language').value||'en-IN'}={},capture=true){field('title').value=title;field('body').value=text;field('language').value=language;if(capture){captureEditor();api.changed()}},
  fire(name){listeners.get(name)?.()},
  async fireRetry(){const pending=[...timers.values()].find(timer=>timer.delay===15000);assert.ok(pending,'a failed cloud write must schedule a retry');pending.fn();await api.flush()},
  requests(method){return calls.filter(c=>c.method===method)}
 };
}

test('delayed cloud read preserves text still in the editor and saves that edit',async()=>{
 const existing=row();const h=browser({rows:[existing]});await h.start();
 const reading=deferred(),release=deferred();let delay=true;
 h.hooks.before=async call=>{if(delay&&call.method==='GET'&&call.url.startsWith('/api/entries')){delay=false;reading.resolve();await release.promise}};
 h.fire('online');await reading.promise;
 h.type({text:'Words typed while the cloud response is delayed'},false);
 release.resolve();await h.flush();
 assert.equal(h.field('body').value,'Words typed while the cloud response is delayed');
 assert.equal(h.state.entries[today].text,'Words typed while the cloud response is delayed');
 assert.equal(h.remote.get(existing.entry_id).journal_text,'Words typed while the cloud response is delayed');
 assert.equal(h.requests('PATCH').at(-1).payload.text,'Words typed while the cloud response is delayed');
});

test('typing during an in-flight create is followed by an update with the latest words',async()=>{
 const h=browser(),accepted=deferred(),release=deferred();
 h.hooks.after=async call=>{if(call.method==='POST'){accepted.resolve();await release.promise}};
 h.type({text:'First version'});const started=h.start();await accepted.promise;
 h.type({text:'Second version while saving'});release.resolve();await started;await h.flush();
 assert.equal(h.requests('POST').length,1);
 assert.equal(h.requests('POST')[0].payload.text,'First version');
 assert.equal(h.requests('PATCH').length,1);
 assert.equal(h.requests('PATCH')[0].payload.text,'Second version while saving');
 assert.equal([...h.remote.values()][0].journal_text,'Second version while saving');
 assert.equal(h.state.entries[today].text,'Second version while saving');
});

test('a response lost after an accepted create retries without duplicating the page',async()=>{
 const h=browser();let loseResponse=true;
 h.hooks.after=async call=>{if(call.method==='POST'&&loseResponse){loseResponse=false;throw Error('Connection dropped after commit')}};
 h.type({text:'Keep these words'});await h.start();
 const requestId=h.requests('POST')[0].payload.requestId;
 assert.equal(h.remote.size,1);
 assert.equal(h.state.entries[today].cloudRequestId,requestId);
 assert.match(h.field('saveStatus').textContent,/cloud pending/);
 await h.fireRetry();
 assert.equal(h.remote.size,1);
 assert.equal(h.requests('POST').length,1,'the retry should discover the already committed page');
 assert.equal(h.state.entries[today].cloud.requestId,requestId);
 assert.equal([...h.remote.values()][0].client_request_id,requestId);
 assert.equal(h.field('saveStatus').textContent,'Saved to Supabase');
});

test('title-only entries, mood, photos, language and clearing edits save without completion data',async()=>{
 const h=browser();h.type({title:'A title without body text',text:''});await h.start();
 assert.equal(h.requests('POST').length,1);
 assert.equal(h.requests('POST')[0].payload.text,'');
 assert.equal(h.requests('POST')[0].payload.title,'A title without body text');
 const e=h.state.entries[today];e.mood='Lovely';e.photos=[{src:'data:image/png;base64,aGVsbG8=',caption:'A moment'}];h.type({language:'ta-IN'});await h.flush();
 const photoSave=h.requests('PATCH').at(-1).payload;
 assert.equal(photoSave.mood,'Lovely');assert.equal(photoSave.language,'ta-IN');assert.deepEqual(photoSave.photos,e.photos);
 const writesBeforeCompletion=h.requests('PATCH').length;
 e.completed=true;e.completedAt=Date.now();await h.flush();
 assert.equal(h.requests('PATCH').length,writesBeforeCompletion,'completion alone must not write to the database');
 e.mood='';e.photos=[];h.type({title:'',text:''});await h.flush();
 const cleared=[...h.remote.values()][0];assert.equal(cleared.title,'');assert.equal(cleared.journal_text,'');assert.equal(cleared.mood,'');assert.deepEqual(cleared.photos,[]);
 for(const request of h.calls.filter(c=>c.payload)){assert.equal('completed' in request.payload,false);assert.equal('completedAt' in request.payload,false)}
 assert.equal(h.state.entries[today].completed,true,'completion stays local while content changes');
});

test('opening an empty journal does not create a blank database row',async()=>{
 const h=browser();await h.start();assert.equal(h.requests('POST').length,0);assert.equal(h.remote.size,0);
});

test('typing after a lost create response resumes saving with the same page instead of a conflict',async()=>{
 const h=browser();let loseResponse=true;
 h.hooks.after=async call=>{if(call.method==='POST'&&loseResponse){loseResponse=false;throw Error('Connection dropped after commit')}};
 h.type({text:'Initial autosaved words'});await h.start();
 const requestId=h.requests('POST')[0].payload.requestId;
 h.type({text:'More words written before reconnecting'});
 await h.flush();
 assert.equal(h.remote.size,1);
 assert.equal([...h.remote.values()][0].client_request_id,requestId);
 assert.equal([...h.remote.values()][0].journal_text,'More words written before reconnecting');
 assert.equal(h.state.entries[today].text,'More words written before reconnecting');
 assert.equal(h.requests('POST').length,1);
 assert.equal(h.requests('PATCH').at(-1)?.payload.text,'More words written before reconnecting');
 assert.equal(h.field('saveStatus').textContent,'Saved to Supabase');
});


test('an actual competing remote update preserves the local edit and reports a conflict',async()=>{
 const existing=row();const h=browser({rows:[existing]});await h.start();
 const remote=h.remote.get(existing.entry_id);remote.journal_text='Words saved by another tab';remote.version++;remote.updated_at='2026-11-01T01:02:00.000Z';
 h.type({text:'My unsent local words'});h.fire('online');await h.flush();
 assert.equal(h.state.entries[today].text,'My unsent local words');
 assert.equal(h.field('body').value,'My unsent local words');
 assert.equal(h.remote.get(existing.entry_id).journal_text,'Words saved by another tab');
 assert.equal(h.requests('PATCH').length,0,'conflicting content must not overwrite the other tab');
 assert.match(h.field('saveStatus').textContent,/conflict/);
});
