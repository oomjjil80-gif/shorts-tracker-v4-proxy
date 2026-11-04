import assert from 'node:assert/strict'
import { ttsSpokenText } from '../lib/generative/longform.js'
assert.equal(ttsSpokenText('장인: 오늘도 치즈가 망가졌다.'), '오늘도 치즈가 망가졌다.')
assert.equal(ttsSpokenText('오디세우스： 들키면 안 돼.'), '들키면 안 돼.')
assert.equal(ttsSpokenText('장인: [지문: 고개를 돌린다] 누구냐?'), '누구냐?')
assert.equal(ttsSpokenText('거인은 말했다. "누구냐?"'), '거인은 말했다. "누구냐?"')
assert.equal(ttsSpokenText('장인의 마음은 복잡했다.'), '장인의 마음은 복잡했다.')
console.log('tts spoken text cases: 5 PASS')
