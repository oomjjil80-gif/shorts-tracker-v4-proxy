import test from 'node:test'
import assert from 'node:assert/strict'
import { zipNinePanels } from '../lib/cardnews/zipNinePanels.js'
test('ZIP contains nine ordered image entries with intact bytes and central directory',()=>{
 const images=Array.from({length:9},(_,i)=>({name:`panel-0${i+1}.png`,bytes:Buffer.from([137,80,78,71,i])}))
 const zip=zipNinePanels(images)
 assert.equal(zip.readUInt32LE(0),0x04034b50)
 assert.equal(zip.readUInt32LE(zip.length-22),0x06054b50)
 assert.equal(zip.readUInt16LE(zip.length-12),9)
 let pos=0
 for(const image of images){
  assert.equal(zip.readUInt32LE(pos),0x04034b50)
  const n=zip.readUInt16LE(pos+26),start=pos+30+n
  assert.equal(zip.subarray(pos+30,start).toString(),image.name)
  assert.deepEqual(zip.subarray(start,start+image.bytes.length),image.bytes)
  pos=start+image.bytes.length
 }
 assert.equal(zip.readUInt32LE(pos),0x02014b50)
})
test('ZIP refuses incomplete or misordered decks',()=>{
 const images=Array.from({length:9},(_,i)=>({name:`panel-0${i+1}.jpg`,bytes:Buffer.from([i+1])}))
 assert.throws(()=>zipNinePanels(images.slice(1)),/nine/)
 assert.throws(()=>zipNinePanels([...images].reverse()),/order/)
})
