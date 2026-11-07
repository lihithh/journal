/* Live Soniox dictation. Only a short-lived, single-use key reaches this browser. */
(()=>{
 const languages={'en-IN':'English','ta-IN':'தமிழ்','te-IN':'తెలుగు','ml-IN':'മലയാളം','hi-IN':'हिन्दी'};
 let session=null,message='Choose a language, then speak. Audio is transcribed by Soniox.';
 function updateUI(){
  const phase=session?.phase,can=editable()&&!historyOpen;
  $('voice').textContent=phase==='starting'?'Cancel microphone':phase==='recording'?'■ Stop listening':phase==='stopping'?'Finishing transcript…':'♩ Speak your thoughts';
  $('voice').disabled=!can||phase==='stopping';$('voice').setAttribute('aria-pressed',session?'true':'false');
  $('language').disabled=!can||!!session;
  $('voiceStatus').textContent=message;
 }
 function say(text){message=text;updateUI()}
 function stopTracks(s){s.stream?.getTracks().forEach(track=>track.stop())}
 function finish(s,error){
  if(session!==s)return;
  session=null;s.abort.abort();clearTimeout(s.connectTimer);clearTimeout(s.drainTimer);clearTimeout(s.durationTimer);clearInterval(s.keepalive);
  if(s.recorder&&s.recorder.state!=='inactive'){try{s.recorder.stop()}catch{}}
  stopTracks(s);
  if(s.socket&&s.socket.readyState<2){try{s.socket.close()}catch{}}
  if(!error){$('voicePreview').textContent='';$('voicePreview').hidden=true}
  say(error||s.notice||(s.hasFinal?'Voice typing stopped. Your transcript saves automatically.':'Voice typing stopped. No speech was recognized.'));
  if(error)toast(error);
  // Flush confirmed words before a date/history navigation continues.
  Promise.resolve(save()).catch(()=>{}).finally(s.resolve);
 }
 function providerError(data){
  if(data.error_code===401||data.error_code===403)return 'Soniox could not authorize this session. Check the API key and speech-to-text permissions, then try again.';
  if(data.error_code===402)return 'Soniox credits or budget are exhausted. Check your Soniox account.';
  if(data.error_code===429)return 'Soniox is busy or at its session limit. Try again shortly.';
  return 'Soniox transcription stopped. Confirmed words are kept; try speaking again.';
 }
 function send(s,data){
  if(session!==s||s.socket?.readyState!==1)return false;
  if(s.socket.bufferedAmount>1024*1024){finish(s,'The connection is too slow for live voice typing. Confirmed words are kept.');return false}
  try{s.socket.send(data);return true}catch{finish(s,'The voice connection was interrupted. Confirmed words are kept.');return false}
 }
 function endAudio(s){
  stopTracks(s);
  if(session!==s)return;
  // MediaRecorder emits its last dataavailable BEFORE stop. Blob sends preserve
  // WebSocket order, so EOS follows every audio frame, including that last one.
  if(!send(s,''))return finish(s,'Voice disconnected before the final words arrived. Confirmed words are kept.');
  s.drainTimer=setTimeout(()=>finish(s,'The last words could not be confirmed. Confirmed words are kept; try again.'),15000);
 }
 function stop(){
  const s=session;if(!s)return Promise.resolve();
  if(s.phase==='starting'){finish(s,'Microphone cancelled.');return s.done}
  if(s.phase==='stopping')return s.done;
  s.phase='stopping';say('Finishing your last words…');clearTimeout(s.durationTimer);clearInterval(s.keepalive);
  if(s.recorder?.state!=='inactive'){try{s.recorder.stop()}catch{finish(s,'Could not finish recording. Confirmed words are kept.')}}
  else endAudio(s);
  return s.done;
 }
 async function temporarySession(s){
  let response;
  try{response=await fetch('/api/voice/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({language:s.language}),credentials:'same-origin',cache:'no-store',signal:s.abort.signal})}
  catch(error){if(s.abort.signal.aborted)throw error;throw Error('Voice typing needs a connection to the local Journal server. Please try again.')}
  const data=await response.json().catch(()=>null);
  if(!response.ok)throw Error(data?.error||'Soniox could not start. Please try again.');
  if(!data?.apiKey?.startsWith('snx_temp_')||data.websocketUrl!=='wss://stt-rt.soniox.com/transcribe-websocket'||!data.config)throw Error('The voice connection settings are invalid. Please restart Journal.');
  return data;
 }
 async function start(){
  await window.journalReady;
  if(session||!editable()||historyOpen)return;
  if(!navigator.onLine)return say('Voice typing needs the internet. You can keep writing offline.');
  if(!navigator.mediaDevices?.getUserMedia||typeof MediaRecorder==='undefined'||typeof WebSocket==='undefined')return say('Live voice typing is unavailable in this browser. Try a current Chrome or Firefox browser.');
  const mimeType=['audio/webm;codecs=opus','audio/ogg;codecs=opus','audio/webm','audio/ogg'].find(type=>MediaRecorder.isTypeSupported(type));
  if(!mimeType)return say('This browser cannot stream a supported audio format. Open Journal in Chrome or Firefox for voice typing.');
  const language=$('language').value;
  if(!languages[language])return say('Choose English, Tamil, Telugu, Malayalam, or Hindi.');
  if(typeof stopMusic==='function')stopMusic();
  const s={date:selected,language,phase:'starting',abort:new AbortController(),hasFinal:false,finished:false};
  s.done=new Promise(resolve=>{s.resolve=resolve});session=s;
  $('voicePreview').hidden=true;$('voicePreview').textContent='';say('Connecting to Soniox…');
  // Covers the local request, microphone prompt and WebSocket setup; cancellation
  // also discards any late microphone grant and stops its tracks immediately.
  s.connectTimer=setTimeout(()=>finish(s,'Voice typing could not start in time. Please try again.'),60000);
  try{
   let settings=await temporarySession(s);if(session!==s)return;
   say('Allow microphone access to begin speaking.');
   const stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true},video:false});
   if(session!==s){stream.getTracks().forEach(track=>track.stop());return}
   s.stream=stream;
   for(const track of stream.getTracks())track.onended=()=>{if(session===s)stop()};
   // Do not use a temporary key that expired while the permission dialog was open.
   if(Date.parse(settings.expiresAt)-Date.now()<5000)settings=await temporarySession(s);
   if(session!==s)return;
   say('Starting '+languages[language]+' voice typing…');
   s.socket=new WebSocket(settings.websocketUrl,['soniox-api-key',settings.apiKey]);
   s.socket.onopen=()=>{
    if(session!==s)return;
    try{
     if(!send(s,JSON.stringify(settings.config)))return;
     s.recorder=new MediaRecorder(stream,{mimeType,audioBitsPerSecond:64000});
     s.recorder.ondataavailable=event=>{if(event.data.size)send(s,event.data)};
     s.recorder.onstop=()=>{if(session===s){s.phase='stopping';updateUI();endAudio(s)}};
     s.recorder.onerror=()=>finish(s,'The microphone stopped unexpectedly. Confirmed words are kept.');
     s.recorder.start(250);s.phase='recording';clearTimeout(s.connectTimer);
     s.keepalive=setInterval(()=>{if(session===s&&s.phase==='recording')send(s,JSON.stringify({type:'keepalive'}))},10000);
     s.durationTimer=setTimeout(()=>{s.notice='Voice session ended. Click Speak your thoughts to continue.';stop()},Math.max(1,(settings.maxSessionSeconds||1800)-10)*1000);
     say('Listening in '+languages[language]+'… Click Stop listening when finished.');
    }catch{finish(s,'The microphone could not start recording. Try another microphone or browser.')}
   };
   s.socket.onmessage=event=>{
    if(session!==s)return;
    let data;try{data=JSON.parse(event.data)}catch{return finish(s,'Soniox sent an unreadable response. Confirmed words are kept.')}
    if(!data||typeof data!=='object'||Array.isArray(data)||('tokens' in data&&(!Array.isArray(data.tokens)||data.tokens.some(token=>!token||typeof token!=='object'||typeof token.text!=='string'||typeof token.is_final!=='boolean'))))return finish(s,'Soniox sent an unreadable response. Confirmed words are kept.');
    if(data.error_code)return finish(s,providerError(data));
    const tokens=Array.isArray(data.tokens)?data.tokens:[];
    const readable=token=>typeof token.text==='string'&&!['<end>','<fin>'].includes(token.text)&&token.translation_status!=='translation';
    const final=tokens.filter(token=>token.is_final===true&&readable(token)).map(token=>token.text).join('');
    if(final){
     const length=appendVoiceTranscript(s.date,s.language,final,!s.hasFinal);s.hasFinal=true;
     if(length>20000&&s.phase==='recording'){s.notice='This page exceeds the 20,000-character cloud limit. Your words are kept locally; shorten the page to finish syncing.';stop()}
    }
    // Provisional guesses may be rewritten. Keep them outside the saved editor.
    if(Array.isArray(data.tokens)){
     const preview=tokens.filter(token=>token.is_final===false&&readable(token)).map(token=>token.text).join('');
     $('voicePreview').textContent=preview;$('voicePreview').hidden=!preview;
    }
    if(data.finished){s.finished=true;finish(s)}
   };
   s.socket.onerror=()=>finish(s,'Could not reach Soniox. Check your internet connection and try again.');
   s.socket.onclose=()=>{if(session===s)finish(s,s.finished?null:'Voice disconnected before all words were confirmed. Confirmed words are kept.')};
  }catch(error){
   if(session!==s)return;
   const denied=['NotAllowedError','SecurityError'].includes(error.name);
   finish(s,denied?'Microphone permission is needed. Allow it in your browser, then try again.':error.name==='NotFoundError'?'No microphone was found. Connect a microphone and try again.':error.message||'Voice typing could not start. Please try again.');
  }
 }
 window.JournalVoice={start,stop,toggle(){return session?stop():start()},active:()=>!!session,updateUI};
 $('voice').onclick=()=>window.JournalVoice.toggle();
 window.addEventListener('pagehide',()=>{if(session)finish(session,'Voice typing stopped when the page closed.')});
 document.addEventListener('visibilitychange',()=>{if(document.hidden&&session)stop()});
 window.journalReady.then(updateUI);
})();
