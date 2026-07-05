// Vercel serverless — FREE neural/natural TTS proxy for the AI Voice Lesson.
// POST {text, voice} -> audio/mpeg.  (browser speechSynthesis is robotic; this is human.)
// Robustness: tries several free voice sources in order and returns the first that works,
// so it keeps functioning even if one endpoint blocks Vercel's IP. No API key, no cost.
//   English:  1) Microsoft Edge neural (Neerja)  2) StreamElements/Polly (Aditi, Indian)  3) Google TTS
//   Kannada:  1) Microsoft Edge neural (Sapna)                                            2) Google TTS
import crypto from 'crypto';
import WebSocket from 'ws';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';
const EDGE = { neerja:'en-IN-NeerjaNeural', prabhat:'en-IN-PrabhatNeural', aria:'en-US-AriaNeural', sapna:'kn-IN-SapnaNeural', gagan:'kn-IN-GaganNeural' };
const POLLY = { neerja:'Aditi', prabhat:'Brian', aria:'Joanna' };   // StreamElements (Amazon Polly) — no Kannada
const TRUSTED = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';

function langOf(voice){ return (voice==='sapna'||voice==='gagan') ? 'kn' : 'en'; }

/* ---- split into <=maxLen pieces on sentence / comma / space boundaries ---- */
function chunkText(text, maxLen){
  var sents = text.replace(/\s+/g,' ').trim().split(/(?<=[.!?।,])\s/);
  var out=[], cur='';
  for(var i=0;i<sents.length;i++){
    var s=sents[i];
    while(s.length>maxLen){ out.push(s.slice(0,maxLen)); s=s.slice(maxLen); }
    if((cur+' '+s).trim().length>maxLen && cur){ out.push(cur.trim()); cur=s; }
    else cur=(cur?cur+' ':'')+s;
  }
  if(cur.trim()) out.push(cur.trim());
  return out;
}
async function fetchBuf(url){
  const c=new AbortController(); const t=setTimeout(()=>c.abort(),8000);
  try{
    const r=await fetch(url,{headers:{'User-Agent':UA,'Accept':'audio/mpeg,*/*'},signal:c.signal});
    if(!r.ok) throw new Error('http'+r.status);
    const ab=await r.arrayBuffer();
    if(ab.byteLength<250) throw new Error('tiny');
    return Buffer.from(ab);
  } finally { clearTimeout(t); }
}
async function synthHTTP(urlBuilder, text, maxLen){
  const parts=chunkText(text, maxLen), bufs=[];
  for(const p of parts){ bufs.push(await fetchBuf(urlBuilder(p))); }
  return Buffer.concat(bufs);
}
const streamElements = (voice) => (chunk) => `https://api.streamelements.com/kappa/v2/speech?voice=${encodeURIComponent(voice)}&text=${encodeURIComponent(chunk)}`;
const googleTTS = (lang) => (chunk) => `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${lang}&q=${encodeURIComponent(chunk)}`;

/* ---- Microsoft Edge "Read aloud" neural voice (best quality) ---- */
function gecToken(){
  let ticks=(BigInt(Math.floor(Date.now()/1000))+11644473600n)*10000000n;
  ticks-=ticks%3000000000n;
  return crypto.createHash('sha256').update(ticks.toString()+TRUSTED,'ascii').digest('hex').toUpperCase();
}
function xmlEsc(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;'); }
function synthEdge(edgeVoice, text){
  return new Promise((resolve,reject)=>{
    const url=`wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED}&Sec-MS-GEC=${gecToken()}&Sec-MS-GEC-Version=1-130.0.2849.68`;
    const ws=new WebSocket(url,{headers:{'Pragma':'no-cache','Cache-Control':'no-cache','Accept-Language':'en-US,en;q=0.9','Origin':'chrome-extension://jdiccldimpahenjbeeknkbpmfdhffelb','User-Agent':UA}});
    const chunks=[]; let done=false;
    const fin=(e)=>{ if(done)return; done=true; clearTimeout(t); try{ws.close();}catch(_){}
      if(e) return reject(e); if(chunks.length) return resolve(Buffer.concat(chunks)); reject(new Error('no-audio')); };
    const t=setTimeout(()=>fin(new Error('timeout')),7000);
    ws.on('open',()=>{
      ws.send(`X-Timestamp:${new Date().toString()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`);
      const lang=edgeVoice.slice(0,5);
      ws.send(`X-RequestId:${crypto.randomBytes(16).toString('hex')}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${new Date().toString()}Z\r\nPath:ssml\r\n\r\n<speak version='1.0' xml:lang='${lang}'><voice name='${edgeVoice}'><prosody rate='-4%'>${xmlEsc(text)}</prosody></voice></speak>`);
    });
    ws.on('message',(data,isBinary)=>{
      if(isBinary){ const b=Buffer.isBuffer(data)?data:Buffer.from(data); if(b.length<2)return; const h=b.readUInt16BE(0); const a=b.subarray(2+h); if(a.length)chunks.push(a); }
      else if(data.toString().includes('Path:turn.end')) fin();
    });
    ws.on('error',fin); ws.on('close',()=>fin());
  });
}

async function synth(voice, text){
  const lang=langOf(voice);
  const attempts = lang==='en'
    ? [ ()=>synthEdge(EDGE[voice]||EDGE.neerja, text),
        ()=>synthHTTP(streamElements(POLLY[voice]||'Aditi'), text, 290),
        ()=>synthHTTP(googleTTS('en'), text, 190) ]
    : [ ()=>synthEdge(EDGE[voice]||EDGE.sapna, text),
        ()=>synthHTTP(googleTTS('kn'), text, 190) ];
  let lastErr;
  for(const a of attempts){ try{ const buf=await a(); if(buf&&buf.length>400) return buf; }catch(e){ lastErr=e; } }
  throw lastErr||new Error('all-failed');
}

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS'){ res.status(200).end(); return; }
  if(req.method!=='POST'){ res.status(405).json({error:'POST only'}); return; }
  try{
    let b=req.body; if(typeof b==='string') b=JSON.parse(b||'{}'); if(!b) b={};
    const text=String(b.text||'').slice(0,2500).trim();
    const voice=EDGE[String(b.voice)]?String(b.voice):'neerja';
    if(!text){ res.status(400).json({error:'no-text'}); return; }
    const audio=await synth(voice, text);
    res.setHeader('Content-Type','audio/mpeg');
    res.setHeader('Cache-Control','public, max-age=86400');
    res.status(200).send(audio);
  }catch(e){ res.status(502).json({error:String(e&&e.message||e).slice(0,200)}); }
}
