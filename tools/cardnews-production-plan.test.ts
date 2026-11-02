import test from 'node:test'
import assert from 'node:assert/strict'
import { createCardnewsProductionPlan } from '../lib/cardnews/productionPlan.js'
import { validateProductionPlan } from '../lib/productionPlan.js'
const panels=Array.from({length:9},(_,i)=>({id:'panel'+(i+1),headline:'장면 '+(i+1),body:i===8?'마지막 장에서 정체 공개':'정체 비공개',imageRef:i===0?'saved/cover.jpg':undefined}))
test('nine-panel carousel maps to common production plan without provider calls',()=>{
 const plan=createCardnewsProductionPlan({id:'cheese-01',title:'치즈 도둑',panels})
 assert.equal(plan.format,'carousel')
 assert.equal(validateProductionPlan(plan).length,11)
 assert.equal(plan.steps[1].config?.existingImageRef,'saved/cover.jpg')
 assert.equal(plan.steps[9].config?.aspectRatio,'4:5')
 assert.deepEqual(plan.steps[10].dependsOn,Array.from({length:9},(_,i)=>'panel-'+(i+1)))
})
test('nine-panel plan rejects incomplete and duplicate decks before execution',()=>{
 assert.throws(()=>createCardnewsProductionPlan({id:'x',title:'x',panels:panels.slice(0,8)}),/nine panels/)
 assert.throws(()=>createCardnewsProductionPlan({id:'x',title:'x',panels:panels.map((p,i)=>i===1?{...p,id:'panel1'}:p)}),/duplicate/)
 assert.throws(()=>createCardnewsProductionPlan({id:'x',title:'x',panels:panels.map((p,i)=>i===8?{...p,body:''}:p)}),/final reveal/)
})
