import { DEFAULT_VOICE_PROFILE, type VoiceProfile } from './voiceProfile.js'
import { geminiImage } from './geminiImage.js'
export type GeneratedBinary={bytes:Buffer;contentType:string;provider:string;model:string}
type FetchLike=typeof fetch
async function checked(r:Response,label:string){if(!r.ok){const t=await r.text();throw new Error(`${label} failed ${r.status}: ${t.slice(0,500)}`)}return r}

// Wisdom Shorts beat picture: portrait 2:3 (as before), drawn by Gemini (geminiImage.ts). A picture blocked for safety
// (no image returned) is asked once more with the calm-scene line, as before.
export async function geminiWisdomImage(prompt:string,apiKey:string,f:FetchLike=fetch):Promise<GeneratedBinary>{
 const call=(p:string)=>geminiImage({prompt:p,aspectRatio:'2:3',imageSize:'1K'},apiKey,f)
 try{return await call(prompt)}catch(e:any){
  if(e?.code!=='no_image')throw e
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

// Wisdom Shorts click thumbnail: a PORTRAIT picture for the 1080x1920 thumbnail (2K: it fills the whole frame).
export async function geminiPortraitImage(prompt:string,apiKey:string,f:FetchLike=fetch):Promise<GeneratedBinary>{
 return geminiImage({prompt,aspectRatio:'9:16',imageSize:'2K'},apiKey,f)
}
// Longform: a landscape 16:9 picture (native ratio, no crop).
export async function geminiLongformImage(prompt:string,apiKey:string,f:FetchLike=fetch):Promise<GeneratedBinary>{
 return geminiImage({prompt,aspectRatio:'16:9',imageSize:'1K'},apiKey,f)
}
// Style-locked picture: drawn FROM the approved reference image, so the art style is carried by the picture itself.
export async function geminiImageWithReference(prompt:string,reference:Buffer,apiKey:string,f:FetchLike=fetch):Promise<GeneratedBinary>{
 return geminiImage({prompt,aspectRatio:'16:9',imageSize:'1K',references:[{bytes:reference,mime:sniffImageMime(reference)}]},apiKey,f)
}
export const sniffImageMime=(b:Buffer)=>(b.length>=2&&b[0]===0x89&&b[1]===0x50?'image/png':b.length>=2&&b[0]===0x52&&b[1]===0x49?'image/webp':'image/jpeg')
