import type { Browser } from 'puppeteer-core'

const PAGE_HOSTS = new Set(['douyin.com', 'www.douyin.com', 'v.douyin.com', 'www.iesdouyin.com'])
const MEDIA_DOMAINS = ['zjcdn.com', 'douyinvod.com', 'bytecdn.cn', 'bytecdn.com', 'byteoversea.com', 'douyin.com', 'iesdouyin.com']

export class DouyinResolverError extends Error {
  constructor(public code: string, message: string) { super(message) }
}

export function douyinVideoId(url: URL): string | null {
  const id = url.pathname.match(/\/(?:share\/)?video\/(\d+)(?:\/|$)/)?.[1] || url.searchParams.get('modal_id')
  return id && /^\d{18,20}$/.test(id) ? id : null
}

export function validateDouyinSource(raw: string): URL {
  const url = new URL(raw)
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !PAGE_HOSTS.has(url.hostname)) {
    throw new DouyinResolverError('DOUYIN_INVALID_URL', 'Expected an HTTPS Douyin video URL')
  }
  if (!douyinVideoId(url) && !(url.hostname === 'v.douyin.com' && /^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname))) {
    throw new DouyinResolverError('DOUYIN_INVALID_URL', 'Douyin video ID or share link is required')
  }
  return url
}

export function validateDouyinMedia(raw: string, videoId: string): URL {
  const url = new URL(raw)
  if (url.protocol !== 'https:' || url.port || url.username || url.password ||
      !MEDIA_DOMAINS.some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain))) {
    throw new DouyinResolverError('DOUYIN_INVALID_MEDIA', `Douyin returned an unexpected media host: ${url.protocol}//${url.hostname}`)
  }
  const mediaId = url.searchParams.get('__vid')
  if (mediaId && mediaId !== videoId) throw new DouyinResolverError('DOUYIN_VIDEO_MISMATCH', 'Player returned a different video')
  return url
}

/** Run the actual public player. No SSR parsing, borrowed cookies, signing service,
 * fingerprint patches, third-party download API, or cached test-video URL. */
export async function resolveDouyin(sourceUrl: string) {
  const source = validateDouyinSource(sourceUrl)
  const expectedId = douyinVideoId(source)
  const [{ default: puppeteer }, { default: chromium }] = await Promise.all([
    import('puppeteer-core'), import('@sparticuz/chromium')
  ])
  let browser: Browser | undefined
  const started = Date.now()
  try {
    browser = await puppeteer.launch({
      args: await puppeteer.defaultArgs({ args: chromium.args, headless: 'shell' }),
      executablePath: await chromium.executablePath(),
      headless: 'shell',
      defaultViewport: { width: 1280, height: 900 },
      timeout: 20_000
    })
    const page = await browser.newPage()
    page.setDefaultTimeout(45_000)
    try {
      await page.goto(source.href, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    } catch (error: any) {
      // A busy page can time out after its player is already available.
      if (error?.name !== 'TimeoutError') throw error
    }
    const stateHandle = await page.waitForFunction(() => {
      const text = document.body?.innerText || ''
      if (/请完成下方验证|请拖动滑块|安全验证|Verify you are human|unusual traffic|Access Denied/i.test(text)) {
        return { blocked: true, mediaUrl: '' }
      }
      const video = document.querySelector('video')
      const mediaUrl = video?.currentSrc || video?.src || video?.querySelector('source')?.src || ''
      return /^https:\/\//.test(mediaUrl) ? { blocked: false, mediaUrl } : false
    }, { timeout: 45_000, polling: 500 })
    const state = await stateHandle.jsonValue() as { blocked: boolean; mediaUrl: string }
    await stateHandle.dispose()
    if (state.blocked) throw new DouyinResolverError('DOUYIN_VERIFICATION_REQUIRED', 'Douyin requires browser verification')
    const finalUrl = validateDouyinSource(page.url())
    const videoId = douyinVideoId(finalUrl)
    if (!videoId || (expectedId && expectedId !== videoId)) {
      throw new DouyinResolverError('DOUYIN_VIDEO_MISMATCH', 'Douyin player did not open the requested video')
    }
    const mediaUrl = validateDouyinMedia(state.mediaUrl, videoId).href
    const title = (await page.title()).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 100)
    return {
      videoId, mediaUrl,
      filename: `douyin_${videoId}_${title || 'source'}.mp4`,
      headers: { 'User-Agent': await browser.userAgent(), Referer: finalUrl.href, Accept: '*/*' },
      resolver: 'douyin-browser',
      resolveMs: Date.now() - started
    }
  } catch (error: any) {
    if (error instanceof DouyinResolverError) throw error
    const code = error?.name === 'TimeoutError' ? 'DOUYIN_PLAYER_TIMEOUT' : 'DOUYIN_BROWSER_FAILED'
    throw new DouyinResolverError(code, `${code}: ${String(error?.message || error).slice(0, 300)}`)
  } finally {
    if (browser) await browser.close().catch(() => browser?.process()?.kill('SIGKILL'))
  }
}
