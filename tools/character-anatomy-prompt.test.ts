import assert from 'node:assert/strict'
import { test } from 'node:test'
import { characterLine, type CharacterBible } from '../lib/generative/seniorLongform.js'

const human: CharacterBible = {
  id: 'odysseus', name: 'Odysseus', role: 'tiny human intruder',
  gender: 'male', age: 'adult', face: 'human face with two eyes',
  hair: 'dark', build: 'small human', outfit: 'human tunic', colors: 'earth tones'
}
const cyclops: CharacterBible = {
  id: 'polyphemus', name: 'Polyphemus', role: 'giant cheesemaker',
  gender: 'male', age: 'adult', face: 'exactly one eye in the middle of the forehead',
  hair: 'dark', build: 'giant', outfit: 'apron', colors: 'earth tones'
}

test('tiny human keeps explicit human anatomy and is not inferred to be a mouse', () => {
  const prompt = characterLine(human)
  assert.match(prompt, /human face with two eyes/)
  assert.match(prompt, /small human/)
  assert.match(prompt, /species/)
  assert.match(prompt, /small size never implies a mouse, rat or other animal/)
})

test('cyclops retains one-eye anatomical description and eye-count constraint', () => {
  const prompt = characterLine(cyclops)
  assert.match(prompt, /exactly one eye in the middle of the forehead/)
  assert.match(prompt, /number of eyes/)
  assert.match(prompt, /facial anatomy/)
})

test('character prompt preserves supplied identity and wardrobe', () => {
  const prompt = characterLine(human)
  assert.match(prompt, /Odysseus/)
  assert.match(prompt, /human tunic/)
  assert.match(prompt, /clothing and proportions/)
})
