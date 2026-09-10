import type { Request, Response } from 'express'
import syncHandler from '../../[...path]'

export default async function handler(req: Request, res: Response) {
  const slot = String((req.query as any).slot || '')
  const index = String((req.query as any).index || '')
  ;(req.query as any).path = ['chunk', slot, index]
  return syncHandler(req, res)
}
