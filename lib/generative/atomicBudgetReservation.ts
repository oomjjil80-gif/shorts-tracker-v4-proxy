import type { SqlDb } from '../jobs/db.js'
import { monthInKst, type Provider } from './monthlyBudgetPolicy.js'
// Approval-bound accounting reservation. $20 is warning only, never a block.
const MICRO=1_000_000
function micros(usd:number):number {
  if(!Number.isFinite(usd)||usd<=0||usd>9000) throw new Error('INVALID_QUOTE')
  const n=Math.ceil(usd*MICRO)
  if(!Number.isSafeInteger(n)) throw new Error('INVALID_QUOTE')
  return n
}
export type ReservationRequest={approvalId:string;reservationId:string;jobId:string;provider:Provider;estimatedUsd:number;now:Date}
export async function reserveApprovedCall(db:SqlDb,input:ReservationRequest):Promise<{warning:boolean;projectedUsd:number}> {
  if(!input.approvalId||!input.reservationId||!input.jobId||!['openai','anthropic','gemini'].includes(input.provider)) throw new Error('INVALID_REQUEST')
  const amount=micros(input.estimatedUsd),month=monthInKst(input.now)
  return db.transaction(async tx=>{
    await tx.query('INSERT INTO ai_monthly_budget(month_kst) VALUES ($1) ON CONFLICT DO NOTHING',[month])
    const budget=await tx.query<{spent_micro_usd:string;reserved_micro_usd:string}>('SELECT spent_micro_usd,reserved_micro_usd FROM ai_monthly_budget WHERE month_kst=$1 FOR UPDATE',[month])
    const row=budget.rows[0]
    if(!row) throw new Error('INVALID_BUDGET_STATE')
    const projected=BigInt(row.spent_micro_usd)+BigInt(row.reserved_micro_usd)+BigInt(amount)
    const approval=await tx.query<{approval_id:string}>(
      `UPDATE ai_paid_approvals SET consumed_at=$1,reservation_id=$2
       WHERE approval_id=$3 AND job_id=$4 AND provider=$5 AND quote_micro_usd=$6
         AND month_kst=$7 AND consumed_at IS NULL AND expires_at>$1
       RETURNING approval_id`,
      [input.now.toISOString(),input.reservationId,input.approvalId,input.jobId,input.provider,amount,month]
    )
    if(approval.rowCount!==1) throw new Error('APPROVAL_REQUIRED')
    await tx.query('UPDATE ai_monthly_budget SET reserved_micro_usd=reserved_micro_usd+$2 WHERE month_kst=$1',[month,amount])
    await tx.query(`INSERT INTO ai_budget_reservations(reservation_id,approval_id,month_kst,reserved_micro_usd,status) VALUES($1,$2,$3,$4,'reserved')`,[input.reservationId,input.approvalId,month,amount])
    return {warning:projected>=20_000_000n,projectedUsd:Number(projected)/MICRO}
  })
}
// Timeout may have been billed; do not release reservation without reconciliation.
// Approval issuance/authentication, settlement and call-site enforcement still pending.
