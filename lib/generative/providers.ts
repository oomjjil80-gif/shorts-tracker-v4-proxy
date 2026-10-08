import { DEFAULT_VOICE_PROFILE, type VoiceProfile } from './voiceProfile.js'
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
export async function openAiTts(text:string,apiKey:string,profile:VoiceProfile=DEFAULT_VOICE_PROFILE,f:FetchLike=fetch):Promise<GeneratedBinary>{
 if(!apiKey)throw new Error('OPENAI_API_KEY is not configured')
 const r=await checked(await f('https://api.openai.com/v1/audio/speech',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({model:profile.model,voice:profile.voice,input:text,instructions:profile.instructions,response_format:profile.responseFormat,speed:profile.speed})}),'speech generation')
 return {bytes:Buffer.from(await r.arrayBuffer()),contentType:'audio/mpeg',provider:'openai',model:profile.model}
}
// Backward-compatible name: existing Wisdom Shorts/Longform keep identical audio while sharing one voice contract.
export async function openAiWisdomTts(text:string,apiKey:string,f:FetchLike=fetch):Promise<GeneratedBinary>{
 return openAiTts(text,apiKey,DEFAULT_VOICE_PROFILE,f)
}

// Wisdom Shorts click thumbnail: a PORTRAIT (9:16-friendly) picture for the 1080x1920 thumbnail. Beat images untouched.
export async function openAiPortraitImage(prompt:string,apiKey:string,f:FetchLike=fetch):Promise<GeneratedBinary>{
 if(!apiKey)throw new Error('OPENAI_API_KEY is not configured')
 const r=await checked(await f('https://api.openai.com/v1/images/generations',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-image-1-mini',prompt,size:'1024x1536',quality:'medium',output_format:'jpeg',n:1})}),'portrait image generation')
 const j:any=await r.json();const b64=j?.data?.[0]?.b64_json
 if(!b64)throw new Error('image generation returned no b64_json')
 return {bytes:Buffer.from(b64,'base64'),contentType:'image/jpeg',provider:'openai',model:'gpt-image-1-mini'}
}
// Wisdom Longform: ONE landscape image per video (composition is forced by longformImagePrompt). Shorts images untouched.
export async function openAiLongformImage(prompt:string,apiKey:string,f:FetchLike=fetch):Promise<GeneratedBinary>{
 if(!apiKey)throw new Error('OPENAI_API_KEY is not configured')
 const r=await checked(await f('https://api.openai.com/v1/images/generations',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-image-1-mini',prompt,size:'1536x1024',quality:'medium',output_format:'jpeg',n:1})}),'longform image generation')
 const j:any=await r.json();const b64=j?.data?.[0]?.b64_json
 if(!b64)throw new Error('image generation returned no b64_json')
 return {bytes:Buffer.from(b64,'base64'),contentType:'image/jpeg',provider:'openai',model:'gpt-image-1-mini'}
}
// Style-locked picture: drawn FROM the approved reference image (image-to-image), so the art style is carried by the
// picture itself, not only by words. 16:9 landscape like every Longform picture.
// Style lock: the approved picture is sent as the reference image. Default gpt-image-1-mini (the same model and price
// class as every other longform picture, ~4x cheaper than gpt-image-1); OPENAI_STYLE_IMAGE_MODEL=gpt-image-1 switches.
// If the chosen model cannot take a reference image (400/404 — never auth/billing), gpt-image-1 is used once instead.
export const STYLE_IMAGE_MODEL=()=>process.env.OPENAI_STYLE_IMAGE_MODEL||'gpt-image-1-mini'
export async function openAiImageWithReference(prompt:string,reference:Buffer,apiKey:string,f:FetchLike=fetch,model=STYLE_IMAGE_MODEL()):Promise<GeneratedBinary>{
 if(!apiKey)throw new Error('OPENAI_API_KEY is not configured')
 const send=(m:string)=>{const form=new FormData()
  form.append('model',m);form.append('prompt',prompt);form.append('size','1536x1024');form.append('quality','medium');form.append('output_format','jpeg');form.append('n','1')
  form.append('image[]',new Blob([new Uint8Array(reference)],{type:'image/jpeg'}),'reference.jpg')
  return f('https://api.openai.com/v1/images/edits',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`},body:form})}
 let used=model,r=await send(model)
 if(!r.ok&&(r.status===400||r.status===404)&&model!=='gpt-image-1'){const t=await r.text();if(!/billing|quota|safety|moderation/i.test(t)){used='gpt-image-1';r=await send(used)}else throw new Error(`style-locked image generation failed ${r.status}: ${t.slice(0,500)}`)}
 await checked(r,'style-locked image generation')
 const j:any=await r.json();const b64=j?.data?.[0]?.b64_json
 if(!b64)throw new Error('image generation returned no b64_json')
 return {bytes:Buffer.from(b64,'base64'),contentType:'image/jpeg',provider:'openai',model:used}
}
