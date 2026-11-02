/** Store-independent ZIP packager. No AI or network calls. ZIP STORE method preserves original images. */
export type ZipEntry = { name: string; bytes: Buffer }
const u16=(n:number)=>{const b=Buffer.alloc(2);b.writeUInt16LE(n);return b}
const u32=(n:number)=>{const b=Buffer.alloc(4);b.writeUInt32LE(n>>>0);return b}
const table=Array.from({length:256},(_,i)=>{let c=i;for(let j=0;j<8;j++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0})
function crc32(b:Buffer){let c=0xffffffff;for(const v of b)c=table[(c^v)&255]^(c>>>8);return(c^0xffffffff)>>>0}
export function zipNinePanels(entries:readonly ZipEntry[]):Buffer {
 if(entries.length!==9)throw Error('exactly nine images required')
 const local:Buffer[]=[],central:Buffer[]=[];let offset=0
 entries.forEach((e,i)=>{
  if(!Buffer.isBuffer(e.bytes)||!e.bytes.length||e.bytes.length>6_000_000)throw Error('invalid image bytes')
  if(!/^panel-0[1-9]\.(png|jpg|webp)$/.test(e.name)||e.name!==`panel-0${i+1}.${e.name.split('.').pop()}`)throw Error('invalid panel order or name')
  const name=Buffer.from(e.name),crc=crc32(e.bytes),size=e.bytes.length
  const head=Buffer.concat([u32(0x04034b50),u16(20),u16(0),u16(0),u16(0),u16(0),u32(crc),u32(size),u32(size),u16(name.length),u16(0),name])
  local.push(head,e.bytes)
  central.push(Buffer.concat([u32(0x02014b50),u16(20),u16(20),u16(0),u16(0),u16(0),u16(0),u32(crc),u32(size),u32(size),u16(name.length),u16(0),u16(0),u16(0),u16(0),u32(0),u32(offset),name]))
  offset+=head.length+size
 })
 const cd=Buffer.concat(central)
 return Buffer.concat([...local,cd,u32(0x06054b50),u16(0),u16(0),u16(9),u16(9),u32(cd.length),u32(offset),u16(0)])
}
