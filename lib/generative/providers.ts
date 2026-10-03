export type GeneratedBinary={bytes:Buffer;contentType:string;provider:string;model:string}
type FetchLike=typeof fetch
async function checked(r:Response,label:string){if(!r.ok){const t=await r.text();throw new Error(`${label} failed ${r.status}: ${t.slice(0,500)}`)}return r}

export async function openAiWisdomImage(prompt:string,apiKey:string,f:FetchLike=fetch):Promise<GeneratedBinary>{
 if(!apiKey)throw new Error('OPENAI_API_KEY is not configured')
 const call=async(p:string)=>{
  const r=await f('https://api.openai.com/v1/images/generations',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-image-1-mini',prompt:p,size:'1024x1536',quality:'low',output_format:'jpeg',n:1})})
  if(!r.ok){const t=await r.text();const e:any=new Error(`image generation failed ${r.status}: ${t.slice(0,500)}`);e.status=r.status;e.body=t;throw e}
  const j:any=await r.json();const b64=j?.data?.[0]?.b64_json
  if(!b64)throw new Error('image generation returned no b64_json')
  return {bytes:Buffer.from(b64,'base64'),contentType:'image/jpeg',provider:'openai',model:'gpt-image-1-mini'} as GeneratedBinary
 }
 try{return await call(prompt)}catch(e:any){
  if(e?.status!==400||!/moderation_blocked|safety_violations/i.test(String(e?.body||e?.message||'')))throw e
  const safe=`${prompt} Calm non-violent everyday scene. No injury, no self-harm, no weapons, no blood, no dangerous action, no threatening gesture. Express emotional tension only through ordinary facial expression, posture, distance, and conversation.`
  return await call(safe)
 }
}
export async function openAiWisdomTts(text:string,apiKey:string,f:FetchLike=fetch):Promise<GeneratedBinary>{
 if(!apiKey)throw new Error('OPENAI_API_KEY is not configured')
 const r=await checked(await f('https://api.openai.com/v1/audio/speech',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-4o-mini-tts',voice:'marin',input:text,instructions:'한국어로 차분하고 따뜻하게, 과장하지 말고 또렷하게 읽어주세요.',response_format:'mp3',speed:1})}),'speech generation')
 return {bytes:Buffer.from(await r.arrayBuffer()),contentType:'audio/mpeg',provider:'openai',model:'gpt-4o-mini-tts'}
}
