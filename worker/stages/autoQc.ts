import { StageError, type StageExecutor } from '../types.js'
import { sha256 } from '../../lib/jobs/blobs.js'
export const autoQcExecutor: StageExecutor = {
 stage:'AUTO_QC', estimateUsd:()=>0, inputHash:j=>sha256(j.id+':auto-qc:'+j.planRev),
 async run({job}) {
   const ref=(job as any).lastOutputRef
   if(!ref) throw new StageError('RENDER_REF_MISSING','AUTO_QC requires render output')
   return {outputRef:ref,outputHash:(job as any).lastOutputHash||null,result:{gate:{decision:'PASS',checks:[{id:'render.exists',required:true,status:'PASS'}]}},costUsd:0}
 }
}
