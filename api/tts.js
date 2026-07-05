// Vercel serverless — FREE neural TTS proxy using Microsoft Edge "Read aloud" voices.
// POST {text, voice} -> audio/mpeg. Powers the AI Voice Lesson's natural human voice
// (the browser's built-in speechSynthesis is robotic). No API key, no signup, no cost.
// Voices: neerja/prabhat = natural Indian English; aria = US English; sapna/gagan = Kannada.
import crypto from 'crypto';
import WebSocket from 'ws';

const TRUSTED = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const VOICES = {
  neerja:  'en-IN-NeerjaNeural',
  prabhat: 'en-IN-PrabhatNeural',
  aria:    'en-US-AriaNeural',
  sapna:   'kn-IN-SapnaNeural',
  gagan:   'kn-IN-GaganNeural'
};

// Microsoft's anti-abuse token: SHA256 of (Windows-filetime rounded to 5 min + trusted token).
function gecToken(){
  let ticks = (BigInt(Math.floor(Date.now()/1000)) + 11644473600n) * 10000000n;
  ticks -= ticks % 3000000000n;
  return crypto.createHash('sha256').update(ticks.toString() + TRUSTED, 'ascii').digest('hex').toUpperCase();
}
function xmlEsc(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;'); }
function buildSSML(voice, text){
  const lang = voice.slice(0,5);
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'>`
       + `<voice name='${voice}'><prosody rate='-4%' pitch='0%'>${xmlEsc(text)}</prosody></voice></speak>`;
}

function synth(voice, text){
  return new Promise((resolve, reject) => {
    const url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1`
              + `?TrustedClientToken=${TRUSTED}&Sec-MS-GEC=${gecToken()}&Sec-MS-GEC-Version=1-130.0.2849.68`;
    const ws = new WebSocket(url, {
      headers: {
        'Pragma':'no-cache', 'Cache-Control':'no-cache',
        'Origin':'chrome-extension://jdiccldimpahenjbeeknkbpmfdhffelb',
        'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'
      }
    });
    const chunks = [];
    let done = false;
    const finish = (err) => {
      if(done) return; done = true;
      clearTimeout(timer);
      try{ ws.close(); }catch(e){}
      if(err) return reject(err);
      if(chunks.length) return resolve(Buffer.concat(chunks));
      reject(new Error('no-audio'));
    };
    const timer = setTimeout(()=>finish(new Error('timeout')), 25000);
    ws.on('open', () => {
      ws.send(`X-Timestamp:${new Date().toString()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`);
      ws.send(`X-RequestId:${crypto.randomBytes(16).toString('hex')}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${new Date().toString()}Z\r\nPath:ssml\r\n\r\n${buildSSML(voice, text)}`);
    });
    ws.on('message', (data, isBinary) => {
      if(isBinary){
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if(buf.length < 2) return;
        const headerLen = buf.readUInt16BE(0);
        const audio = buf.subarray(2 + headerLen);
        if(audio.length) chunks.push(audio);
      } else {
        if(data.toString().includes('Path:turn.end')) finish();
      }
    });
    ws.on('error', (e) => finish(e));
    ws.on('close', () => finish());
  });
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS'){ res.status(200).end(); return; }
  if(req.method!=='POST'){ res.status(405).json({error:'POST only'}); return; }
  try{
    let b = req.body; if(typeof b==='string') b = JSON.parse(b||'{}'); if(!b) b={};
    const text = String(b.text||'').slice(0, 2500).trim();
    const voice = VOICES[String(b.voice||'neerja')] || VOICES.neerja;
    if(!text){ res.status(400).json({error:'no-text'}); return; }
    const audio = await synth(voice, text);
    res.setHeader('Content-Type','audio/mpeg');
    res.setHeader('Cache-Control','public, max-age=86400');
    res.status(200).send(audio);
  }catch(e){
    res.status(502).json({error:String(e && e.message || e).slice(0,200)});
  }
}
