import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import type { SqlDb, Queryable } from '../lib/jobs/db.js'
import { reserveApprovedCall } from '../lib/generative/atomicBudgetReservation.js'

async function fixture() {
  const pg = new PGlite()
  await pg.exec(readFileSync(new URL('../db/999_ai_budget_reservations.sql',import.meta.url),'utf8'))
  const wrap=(c:{query:PGlite['query']}):Queryable=>({query:async(sql,params)=>{const r:any=await c.query(sql,params as any[]);return {rows:r.rows,rowCount:r.affectedRows??r.rows.length}}})
  const db:SqlDb={...wrap(pg),transaction:fn=>pg.transaction(tx=>fn(wrap(tx as any))),close:()=>pg.close()}
  const now=new Date('2026-10-26T04:00:00Z')
  const approve=async(id:string,usd:number,provider='gemini')=> {
    await db.query(`INSERT INTO ai_paid_approvals(approval_id,job_id,provider,quote_micro_usd,month_kst,expires_at)
    VALUES($1,'job-1',$2,$3,'202610',$4)`,[id,provider,Math.ceil(usd*1e6),'2026-10-27T04:00:00Z'])
  }
  const reserve=(approvalId:string,reservationId:string,estimatedUsd:number)=>reserveApprovedCall(db,{approvalId,reservationId,jobId:'job-1',provider:'gemini',estimatedUsd,now})
  return {db,approve,reserve}
}
test('warning above $20 does not block approved calls',async()=>{
  const f=await fixture()
  try {
    await f.approve('a1',19)
    assert.equal((await f.reserve('a1','r1',19)).warning,false)
    await f.approve('a2',2)
    const result=await f.reserve('a2','r2',2)
    assert.equal(result.warning,true)
    assert.equal(result.projectedUsd,21)
    const row=await f.db.query<any>('SELECT reserved_micro_usd FROM ai_monthly_budget WHERE month_kst=$1',['202610'])
    assert.equal(Number(row.rows[0].reserved_micro_usd),21_000_000)
  } finally {await f.db.close?.()}
})
test('single-use approval cannot be replayed',async()=>{
  const f=await fixture()
  try {
    await f.approve('a1',1)
    await f.reserve('a1','r1',1)
    await assert.rejects(()=>f.reserve('a1','r2',1),/APPROVAL_REQUIRED/)
  } finally {await f.db.close?.()}
})
test('mismatched quote or missing approval is rejected',async()=>{
  const f=await fixture()
  try {
    await f.approve('a1',1)
    await assert.rejects(()=>f.reserve('a1','r1',2),/APPROVAL_REQUIRED/)
    await assert.rejects(()=>f.reserve('missing','r2',1),/APPROVAL_REQUIRED/)
    const rows=await f.db.query<any>('SELECT * FROM ai_budget_reservations')
    assert.equal(rows.rows.length,0)
  } finally {await f.db.close?.()}
})
test('concurrent attempts on one approval cannot both succeed',async()=>{
  const f=await fixture()
  try {
    await f.approve('a1',1)
    const results=await Promise.allSettled([f.reserve('a1','r1',1),f.reserve('a1','r2',1)])
    assert.equal(results.filter(x=>x.status==='fulfilled').length,1)
    const rows=await f.db.query<any>('SELECT * FROM ai_budget_reservations')
    assert.equal(rows.rows.length,1)
  } finally {await f.db.close?.()}
})
