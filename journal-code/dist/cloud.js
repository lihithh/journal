/* Personal local Journal: credentials stay in the Node backend, never in the browser. */
(()=>{
 let workspace=null,inFlight=null,rerun=false,pullRequested=true,lastError=null,cloudTimer;
 const conflicts=new Set();
 const content=e=>({title:e.title||'',text:e.text||'',language:e.language||'en-IN',mood:e.mood||'',photos:(e.photos||[]).map(p=>({src:p.src,caption:p.caption||''}))});
 const signature=e=>JSON.stringify(content(e));
 const meaningful=e=>!!(e.title?.trim()||e.text?.trim()||e.mood||e.photos?.length);
 const belongs=e=>e.cloud?.workspaceId===workspace?.id;
 const dirty=e=>(meaningful(e)||e.cloud)&&(!belongs(e)||signature(e)!==e.cloud.signature);
 const rowEntry=r=>({date:r.journal_date,title:r.title,text:r.journal_text,language:r.language,mood:r.mood,photos:r.photos,createdAt:Date.parse(r.created_at),updatedAt:Date.parse(r.updated_at)});
 const metadata=r=>({workspaceId:workspace.id,id:r.entry_id,version:r.version,updatedAt:r.updated_at,requestId:r.client_request_id,signature:signature(rowEntry(r))});
 async function api(route,options={}){
  let response;
  try{response=await fetch('/api/'+route,{...options,headers:{'Content-Type':'application/json',...options.headers},credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(30000)})}
  catch{throw Error('Cloud is unreachable. Changes are saved on this device and will retry automatically.')}
  const data=await response.json().catch(()=>null);
  if(!response.ok){const error=Error(data?.error||'Cloud saving is temporarily unavailable.');error.status=response.status;throw error}
  return data;
 }
 function status(){
  let text;
  if(!persistOk)text='Device save failed · keep this page open';
  else if(!navigator.onLine)text='Offline · saved on this device';
  else if(conflicts.size)text='Sync conflict · local copy kept';
  else if(lastError)text='Saved on device · cloud pending';
  else if(inFlight)text='Saving to Supabase…';
  else if(!workspace)text='Connecting to Supabase…';
  else if(Object.values(entries).some(dirty))text='Saved on device · cloud pending';
  else text=current()?'Saved to Supabase':'Supabase connected · autosave on';
  $('saveStatus').textContent=text;$('deviceStatus').textContent='● '+text;
  $('deviceStatus').title=lastError?.message||'Journal content saves automatically. Completion is a local visual marker.';
  document.documentElement.dataset.cloudStatus=text;
 }
 function schedule(delay=500){clearTimeout(cloudTimer);cloudTimer=setTimeout(()=>{cloudTimer=null;sync()},delay)}
 function refreshView(){
  const active=document.activeElement,id=active?.id,start=active?.selectionStart,end=active?.selectionEnd;
  if(historyOpen)renderHistory();else render();
  if(id&&(id==='title'||id==='body')){const field=$(id);field.focus();if(start!==null)field.setSelectionRange(start,end)}
 }
 async function pull(){
  const remote=[];let cursor=null;
  do{const page=await api('entries'+(cursor?'?after='+encodeURIComponent(cursor):''));remote.push(...page.entries);cursor=page.next}while(cursor);
  // Capture current DOM edits before considering any remote replacement.
  captureEditor();let refresh=false;conflicts.clear();
  for(const r of remote){
   const key=r.journal_date,e=entries[key],remoteEntry=rowEntry(r),remoteSignature=signature(remoteEntry);
   if(e&&meaningful(e)&&(!belongs(e)||e.cloud.id!==r.entry_id)){
    if(signature(e)===remoteSignature||e.cloudRequestId===r.client_request_id)e.cloud=metadata(r);else conflicts.add(key);
    continue;
   }
   if(e&&belongs(e)&&signature(e)!==e.cloud.signature){
    if(e.cloud.version!==r.version||e.cloud.updatedAt!==r.updated_at)conflicts.add(key);
    continue;
   }
   if(!e||signature(e)!==remoteSignature){
    // Keep completion local, and retain object identity for pending photo work.
    entries[key]=Object.assign(e||{completed:false},remoteEntry,{cloud:metadata(r)});
    if(key===selected)refresh=true;
   }else e.cloud=metadata(r);
  }
  if(refresh||historyOpen)refreshView();
  await writeStore('entries',entries);
 }
 async function run(){
  await window.journalReady;
  try{
   lastError=null;
   await save({notifyCloud:false});
   if(!persistOk)throw Error('Device storage is unavailable. Keep this page open and export a backup.');
   if(!workspace){const session=await api('session');workspace=session.workspace;pullRequested=true}
   if(pullRequested){pullRequested=false;await pull()}
   for(const key of Object.keys(entries)){
    captureEditor();const e=entries[key];
    if(!dirty(e)||conflicts.has(key))continue;
    const payload=content(e);let result;
    try{
     if(belongs(e)){
      result=await api('entries/'+e.cloud.id,{method:'PATCH',body:JSON.stringify({...payload,expectedVersion:e.cloud.version,expectedUpdatedAt:e.cloud.updatedAt})});
     }else{
      e.cloudRequestId??=crypto.randomUUID();
      await writeStore('entries',entries);
      result=await api('entries',{method:'POST',body:JSON.stringify({...payload,date:e.date,requestId:e.cloudRequestId})});
     }
    }catch(error){if(error.status===409){conflicts.add(key);continue}throw error}
    const live=entries[key];
    if(live){live.cloud=metadata(result.entry);if(signature(live)!==live.cloud.signature)rerun=true}
    await writeStore('entries',entries);
   }
   if(conflicts.size)toast('A page changed in another tab. Your local copy is kept; export it before resolving the conflict.');
  }catch(error){lastError=error;pullRequested=true;rerun=false;schedule(15000)}
 }
 function sync(){
  if(inFlight){rerun=true;return inFlight}
  clearTimeout(cloudTimer);cloudTimer=null;
  inFlight=run().finally(()=>{inFlight=null;status();if(rerun){rerun=false;schedule(100)}});
  status();return inFlight;
 }
 window.JournalCloud={
  changed(){lastError=null;status();if(inFlight)rerun=true;else schedule()},
  status,
  flush:sync
 };
 window.addEventListener('online',()=>{pullRequested=true;sync()});
 window.addEventListener('offline',status);
 document.addEventListener('visibilitychange',()=>{if(!document.hidden){pullRequested=true;sync()}else sync()});
 setInterval(()=>{pullRequested=true;sync()},60000);
 window.journalReady.then(sync);
})();
