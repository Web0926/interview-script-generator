import crypto from 'node:crypto'
import { getEnv } from './env.mjs'

/**
 * WeChat Mini Program Virtual Payment (虚拟支付)
 * Uses wx.requestVirtualPayment API
 */

const OFFER_ID = () => getEnv('WX_OFFER_ID')
const APP_KEY = () => getEnv('WX_APP_KEY')
const PRODUCT_ID = () => getEnv('WX_PRODUCT_ID', 'interview_session_1')
const GOODS_PRICE = () => Number(getEnv('WX_GOODS_PRICE', '4990'))

function generateOutTradeNo() {
  const now = new Date()
  const date = now.toISOString().slice(0, 10).replace(/-/g, '')
  const rand = crypto.randomBytes(6).toString('hex')
  return `WX${date}${rand}`
}

/**
 * Calculate paySig = HMAC-SHA256(appKey, uri + "&" + signDataJson)
 */
function calcPaySig(uri, signDataJson) {
  const appKey = APP_KEY()
  const msg = uri + '&' + signDataJson
  return crypto.createHmac('sha256', appKey).update(msg, 'utf8').digest('hex')
}

/**
 * Calculate signature = HMAC-SHA256(session_key, signDataJson)
 */
function calcSignature(signDataJson, sessionKey) {
  return crypto.createHmac('sha256', sessionKey).update(signDataJson, 'utf8').digest('hex')
}

/**
 * Build virtual payment params for wx.requestVirtualPayment
 * @param {object} opts
 * @param {string} opts.sessionKey - user's session_key from code2Session
 * @param {number} opts.userId - internal user id (for attach data)
 * @param {string} opts.outTradeNo - order number
 * @param {number} [opts.env=1] - 0=production, 1=sandbox
 */
export function buildVirtualPaymentParams({ sessionKey, userId, outTradeNo, env = 1 }) {
  const offerId = OFFER_ID()
  const productId = PRODUCT_ID()
  const goodsPrice = GOODS_PRICE()

  if (!offerId || !APP_KEY()) {
    throw Object.assign(new Error('虚拟支付未配置'), { code: 'WX_VPAY_NOT_CONFIGURED' })
  }

  const signData = {
    offerId,
    buyQuantity: 1,
    currencyType: 'CNY',
    outTradeNo,
    attach: JSON.stringify({ userId }),
    env,
    productId,
    goodsPrice,
  }

  // MUST stringify server-side to ensure consistent JSON format
  const signDataJson = JSON.stringify(signData)

  const paySig = calcPaySig('requestVirtualPayment', signDataJson)
  const signature = calcSignature(signDataJson, sessionKey)

  return {
    mode: 'short_series_goods',
    signData,
    paySig,
    signature,
  }
}

/**
 * Verify delivery callback signature (optional but recommended)
 */
export function calcNotifyPaySig(uri, bodyJson) {
  return calcPaySig(uri, bodyJson)
}

/**
 * Call /xpay/notify_provide_goods to confirm delivery to WeChat
 */
export async function notifyProvideGoods({ outTradeNo }) {
  const appid = getEnv('WX_APPID')
  const offerId = OFFER_ID()

  const data = {
    openid: '', // filled by caller if needed
    appid,
    offer_id: offerId,
    out_trade_no: outTradeNo,
    product_id: PRODUCT_ID(),
    quantity: 1,
  }

  const dataJson = JSON.stringify(data)
  const paySig = calcPaySig('/xpay/notify_provide_goods', dataJson)

  const accessToken = await getAccessToken()

  const url = `https://api.weixin.qq.com/xpay/notify_provide_goods?pay_sig=${encodeURIComponent(paySig)}&access_token=${encodeURIComponent(accessToken)}`

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: dataJson,
  })

  const result = await res.json()
  console.log('[wx-vpay] notify_provide_goods response:', JSON.stringify(result))
  return result
}

/**
 * Get access_token for server-to-server API calls
 */
let cachedAccessToken = null
let tokenExpiresAt = 0

async function getAccessToken() {
  if (cachedAccessToken && Date.now() < tokenExpiresAt) {
    return cachedAccessToken
  }

  const appid = getEnv('WX_APPID')
  const secret = getEnv('WX_SECRET')

  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appid}&secret=${secret}`
  const res = await fetch(url)
  const data = await res.json()

  if (data.errcode) {
    console.error('[wx-vpay] getAccessToken failed:', JSON.stringify(data))
    throw new Error('获取access_token失败')
  }

  cachedAccessToken = data.access_token
  // Expire 5 minutes early to be safe
  tokenExpiresAt = Date.now() + (data.expires_in - 300) * 1000

  return cachedAccessToken
}

export { generateOutTradeNo }
