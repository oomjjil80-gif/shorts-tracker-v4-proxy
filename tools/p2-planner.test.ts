import test from 'node:test'
import assert from 'node:assert/strict'
import { applyVisualBible } from '../lib/generative/planner.js'
import { validateWisdomScript } from '../lib/generative/wisdom.js'
import { normalizeGenerativeBrief } from '../lib/generative/contracts.js'

test('visual bible is applied consistently to every wisdom image prompt',()=>{
 const brief=normalizeGenerativeBrief({kind:'topic',text:'관계의 지혜',targetSeconds:40})
 const beats=Array.from({length:4},(_,i)=>({id:`b${i+1}`,narration:`말 ${i+1}`,visualGoal:`goal ${i+1}`,imagePrompt:`scene ${i+1}`,durationSec:10}))
 const script:any={schema:'wisdom-script/1',title:'관계',hook:'훅',beats,ending:'여운',totalSeconds:40}
 const bible:any={schema:'wisdom-visual-bible/1',style:'soft editorial watercolor',palette:'warm muted earth',lighting:'gentle morning',composition:'one clear focal subject',characterPolicy:'same mature Korean protagonist when recurring',negative:'text, clutter, watermark'}
 const out=applyVisualBible(script,bible)
 assert.deepEqual(validateWisdomScript(out,brief),[])
 for(const b of out.beats){assert.match(b.imagePrompt,/soft editorial watercolor/);assert.match(b.imagePrompt,/warm muted earth/);assert.match(b.imagePrompt,/no readable text/)}
})
