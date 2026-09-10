import type { Request, Response } from 'express'
import syncHandler from './[...path]'

export default async function handler(req: Request, res: Response) {
  ;(req.query as any).path = ['manifest']
  return syncHandler(req, res)
}
