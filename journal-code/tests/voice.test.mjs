import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../dist/voice.js',import.meta.url),'utf8');
const app=await readFile(new URL('../dist/app.js',import.meta.url),'utf8');
const appendSource=app.slice(app.indexOf('function appendVoiceTranscript('),app.indexOf("$('body').oninput=$('title').oninput=editorChanged;"));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}};
const microtasks=async()=>{for(let i=0;i<8;i++)await Promise.resolve()};
const day='2026-11-01';

// Exercises the actual voice module and app append helper through browser events.
// Microphone, MediaRecorder and WebSocket are fakes: no recording/provider calls.
function browser(options={}){
 const fields=new Map(),sockets=[],recorders=[],timers=new Map(),intervals=new Map(),toasts=[],saves=[],appends=[];
 const windowListeners=new Map(),documentListeners=new Map();let nextTimer=0,gumCalls=0;
 const microphoneRequested=deferred();
 const state={entries:{},selected:day,editable:true,historyOpen:false};
 const track={stops:0,stop(){this.stops++}};const stream={getTracks:()=>[track]};
 const finalBlob={size:16,label:'last recording chunk'};
 function field(id){if(!fields.has(id))fields.set(id,{id,value:id==='language'?(options.language||'ta-IN'):'',textContent:'',hidden:true,disabled:false,attributes:{},selectionStart:0,selectionEnd:0,setAttribute(name,value){this.attributes[name]=value},setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end}});return fields.get(id)}
 const document={activeElement:null,hidden:false,addEventListener(name,fn){documentListeners.set(name,fn)}};
 class Socket{
  constructor(url,protocols){this.url=url;this.protocols=protocols;this.sent=[];this.readyState=0;this.bufferedAmount=0;sockets.push(this)}
  open(){this.readyState=1;this.onopen?.()}
  send(data){if(this.readyState!==1)throw Error('not open');this.sent.push(data)}
  message(data){return this.onmessage?.({data:typeof data==='string'?data:JSON.stringify(data)})}
  close(){this.readyState=3;this.onclose?.({code:1000})}
  drop(){this.readyState=3;this.onclose?.({code:1000})}
 }
 class Recorder{
  static isTypeSupported(type){return options.supportedFormats!==false&&type==='audio/webm;codecs=opus'}
  constructor(source,config){this.stream=source;this.config=config;this.state='inactive';recorders.push(this);if(options.recorderConstructorError)throw Error('recorder failed')}
  start(timeslice){this.state='recording';this.timeslice=timeslice}
  stop(){this.state='inactive';queueMicrotask(()=>{this.ondataavailable?.({data:finalBlob});this.onstop?.()})}
  audio(blob={size:12,label:'audio chunk'}){this.ondataavailable?.({data:blob});return blob}
 }
 const window={journalReady:Promise.resolve(),addEventListener(name,fn){windowListeners.set(name,fn)}};
 async function fetcher(url,request){
  assert.equal(url,'/api/voice/session');assert.equal(request.method,'POST');
  const language=JSON.parse(request.body).language;
  if(options.keyResponse)return options.keyResponse;
  return Response.json({apiKey:'snx_temp_test_browser_only',expiresAt:new Date(Date.now()+60000).toISOString(),websocketUrl:'wss://stt-rt.soniox.com/transcribe-websocket',config:{model:'stt-rt-v5',audio_format:'auto',language_hints:[language.split('-')[0]],enable_endpoint_detection:true},maxSessionSeconds:1800});
 }
 function captureEditor(){const e=state.entries[state.selected];if(e)e.text=field('body').value}
 async function save(){captureEditor();saves.push(structuredClone(state.entries));if(options.saveGate)await options.saveGate.promise}
 const context=vm.createContext({window,document,navigator:{onLine:options.online!==false,mediaDevices:{async getUserMedia(){gumCalls++;microphoneRequested.resolve();if(options.gum)return options.gum();return stream}}},MediaRecorder:Recorder,WebSocket:Socket,fetch:fetcher,AbortController,Date,Promise,$:field,editable:()=>state.editable,get selected(){return state.selected},get historyOpen(){return state.historyOpen},get entries(){return state.entries},captureEditor,markEntryChanged(e){e.updatedAt=Date.now();e.localRevision=(e.localRevision||0)+1},words:text=>text.trim().split(/\s+/).filter(Boolean).length,save,toast:message=>toasts.push(message),get timer(){return null},set timer(v){},setTimeout(fn,delay){const id=++nextTimer;timers.set(id,{fn,delay});return id},clearTimeout(id){timers.delete(id)},setInterval(fn,delay){const id=++nextTimer;intervals.set(id,{fn,delay});return id},clearInterval(id){intervals.delete(id)}});
 vm.runInContext(appendSource,context,{filename:'app-voice-helper.js'});
 vm.runInContext('const originalAppend=appendVoiceTranscript;appendVoiceTranscript=(...args)=>{recordAppend(args);return originalAppend(...args)};',Object.assign(context,{recordAppend:args=>appends.push(Array.from(args))}));
 vm.runInContext(source,context,{filename:'voice.js'});
 const api=window.JournalVoice;
 return {api,state,field,sockets,recorders,track,stream,finalBlob,toasts,saves,appends,timers,intervals,microphoneRequested,get gumCalls(){return gumCalls},
  async start(){await api.start();await microtasks();return sockets.at(-1)},
  async record(){const socket=await this.start();socket?.open();await microtasks();return socket},
  async runTimers(delay){for(const [id,timer]of [...timers])if(timer.delay===delay){timers.delete(id);timer.fn()}await microtasks()},
  hide(){document.hidden=true;documentListeners.get('visibilitychange')?.()},
  closePage(){windowListeners.get('pagehide')?.()}
 };
}

test('stop sends the final recording chunk before text EOS and waits for finished plus saving',async()=>{
 const saveGate=deferred(),h=browser({saveGate});const socket=await h.record();
 const config=JSON.parse(socket.sent[0]);assert.equal(config.audio_format,'auto');assert.deepEqual(config.language_hints,['ta']);assert.equal('api_key' in config,false);
 assert.deepEqual(Array.from(socket.protocols),['soniox-api-key','snx_temp_test_browser_only']);
 const audio=h.recorders[0].audio();let stopped=false;const stop=h.api.stop().then(()=>{stopped=true});await microtasks();
 assert.equal(socket.sent[1],audio);assert.equal(socket.sent[2],h.finalBlob);assert.equal(socket.sent[3],'');
 assert.equal(stopped,false,'stop must wait for final provider tokens');assert.equal(h.api.active(),true);assert.ok(h.track.stops>0);
 socket.message({tokens:[{text:'வணக்கம்',is_final:true}],finished:true});await microtasks();
 assert.equal(stopped,false,'navigation must wait until confirmed words have been saved');
 saveGate.resolve();await stop;assert.equal(stopped,true);assert.equal(h.state.entries[day].text,'வணக்கம்');assert.equal(h.api.active(),false);assert.equal(h.intervals.size,0);
});

test('native-script subwords concatenate without inserted spaces; provisional guesses never save',async()=>{
 const h=browser();const socket=await h.record();
 socket.message({tokens:[{text:'தவறு',is_final:false}]});
 assert.equal(h.field('voicePreview').textContent,'தவறு');assert.equal(h.state.entries[day],undefined);assert.equal(h.appends.length,0);
 socket.message({tokens:[{text:'வண',is_final:true},{text:'க்கம்',is_final:false}]});
 socket.message({tokens:[{text:'க்கம்',is_final:true},{text:' ',is_final:true},{text:'மிக',is_final:true}]});
 socket.message({tokens:[{text:' மிக',is_final:true},{text:'<end>',is_final:true},{text:'<fin>',is_final:true},{text:'translated English',is_final:true,translation_status:'translation'}]});
 assert.equal(h.state.entries[day].text,'வணக்கம் மிக மிக');assert.equal(h.field('body').value,'வணக்கம் மிக மிக');
 assert.deepEqual(h.appends.map(call=>call[3]),[true,false,false]);
 await h.runTimers(150);assert.equal(h.saves.at(-1)[day].text,'வணக்கம் மிக மிக');
 const stopped=h.api.stop();await microtasks();socket.message({tokens:[],finished:true});await stopped;
 assert.equal(h.field('voicePreview').textContent,'');assert.equal(h.field('voicePreview').hidden,true);
});

test('final words belong to the recording date even after the visible date changes',async()=>{
 const h=browser({language:'ml-IN'});const socket=await h.record();
 const other='2026-11-02';h.state.entries[other]={date:other,text:'Another day',title:'',language:'en-IN'};h.state.selected=other;h.field('body').value='Another day';
 socket.message({tokens:[{text:'നമസ്കാരം',is_final:true}]});
 assert.equal(h.state.entries[day].text,'നമസ്കാരം');assert.equal(h.state.entries[day].language,'ml-IN');
 assert.equal(h.state.entries[other].text,'Another day');assert.equal(h.field('body').value,'Another day');
 const stopped=h.api.stop();await microtasks();socket.message({tokens:[],finished:true});await stopped;
 assert.equal(h.saves.at(-1)[day].text,'നമസ്കാരം');assert.equal(h.saves.at(-1)[other].text,'Another day');
});

test('an empty finished response creates no phantom entry',async()=>{
 const h=browser();const socket=await h.record();socket.message({tokens:[],finished:true});await microtasks();
 assert.deepEqual(Object.keys(h.state.entries),[]);assert.equal(h.appends.length,0);assert.match(h.field('voiceStatus').textContent,/No speech/);assert.equal(h.api.active(),false);assert.ok(h.track.stops>0);
});

test('microphone denial reports an actionable error and restores controls',async()=>{
 const h=browser({gum:async()=>{throw Object.assign(Error('Denied'),{name:'NotAllowedError'})}});await h.start();
 assert.equal(h.api.active(),false);assert.equal(h.sockets.length,0);assert.equal(h.field('language').disabled,false);assert.match(h.field('voiceStatus').textContent,/permission/i);assert.equal(h.intervals.size,0);
});

test('cancel while permission is pending stops a microphone granted later',async()=>{
 const permission=deferred(),h=browser({gum:()=>permission.promise});const starting=h.api.start();await h.microphoneRequested.promise;
 await h.api.stop();assert.equal(h.api.active(),false);permission.resolve(h.stream);await starting;
 assert.equal(h.track.stops,1);assert.equal(h.sockets.length,0);assert.equal(h.recorders.length,0);
});

test('a failed temporary-key request does not ask for the microphone',async()=>{
 const h=browser({keyResponse:Response.json({error:'Voice is not configured'},{status:503})});await h.start();
 assert.equal(h.gumCalls,0);assert.equal(h.api.active(),false);assert.equal(h.sockets.length,0);assert.match(h.field('voiceStatus').textContent,/not configured/);
});

test('provider errors and a normal close without finished stop the microphone and retain confirmed text',async t=>{
 for(const failure of ['provider','close','network','recorder'])await t.test(failure,async()=>{
  const h=browser({language:'hi-IN'});const socket=await h.record();socket.message({tokens:[{text:'नमस्ते',is_final:true}]});
  if(failure==='provider')socket.message({tokens:[],error_code:402,error_type:'insufficient_credits'});
  else if(failure==='close')socket.drop();else if(failure==='network')socket.onerror?.();else h.recorders[0].onerror?.();
  await microtasks();assert.equal(h.api.active(),false);assert.ok(h.track.stops>0);assert.equal(h.recorders[0].state,'inactive');assert.equal(h.state.entries[day].text,'नमस्ते');assert.ok(h.toasts.length);assert.equal(h.intervals.size,0);
 });
});

test('malformed provider frames clean up the microphone instead of leaving it recording',async t=>{
 for(const bad of ['not JSON','null',JSON.stringify({tokens:[null]}),JSON.stringify({tokens:[{text:99,is_final:true}]})])await t.test(bad,async()=>{
  const h=browser();const socket=await h.record();assert.doesNotThrow(()=>socket.message(bad));await microtasks();
  assert.equal(h.api.active(),false);assert.ok(h.track.stops>0);assert.equal(h.appends.length,0);assert.ok(h.toasts.length);
 });
});

test('offline and unsupported recording formats never start capture',async t=>{
 for(const options of [{online:false},{supportedFormats:false}])await t.test(JSON.stringify(options),async()=>{const h=browser(options);await h.start();assert.equal(h.gumCalls,0);assert.equal(h.api.active(),false);assert.equal(h.sockets.length,0)});
});

test('dictation preserves unsaved typing and adds only the first natural word boundary',async()=>{
 const h=browser();h.state.entries[day]={date:day,text:'Previously saved',title:'',language:'en-IN',photos:[],mood:''};h.field('body').value='Previously saved';
 const socket=await h.record();h.field('body').value='Latest unsaved typing';
 socket.message({tokens:[{text:'வண',is_final:true}]});socket.message({tokens:[{text:'க்கம்',is_final:true}]});
 assert.equal(h.state.entries[day].text,'Latest unsaved typing வணக்கம்');assert.equal(h.field('body').value,'Latest unsaved typing வணக்கம்');
 const stopped=h.api.stop();await microtasks();socket.message({tokens:[],finished:true});await stopped;
 assert.equal(h.saves.at(-1)[day].text,'Latest unsaved typing வணக்கம்');
});

test('dictated punctuation joins existing text without a false separator',async()=>{
 const h=browser({language:'hi-IN'});h.state.entries[day]={date:day,text:'नमस्ते',title:'',language:'hi-IN'};h.field('body').value='नमस्ते';
 const socket=await h.record();socket.message({tokens:[{text:'।',is_final:true}]});
 assert.equal(h.state.entries[day].text,'नमस्ते।');
 const stopped=h.api.stop();await microtasks();socket.message({tokens:[],finished:true});await stopped;
});

test('each supported language can start without requesting translation',async t=>{
 for(const language of ['en-IN','ta-IN','te-IN','ml-IN','hi-IN'])await t.test(language,async()=>{
  const h=browser({language}),socket=await h.record();const config=JSON.parse(socket.sent[0]);assert.deepEqual(config.language_hints,[language.split('-')[0]]);assert.equal('translation' in config,false);assert.equal(h.api.active(),true);
  socket.message({tokens:[],finished:true});await microtasks();
 });
});
