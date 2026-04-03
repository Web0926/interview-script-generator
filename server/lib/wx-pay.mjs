import crypto from 'node:crypto'
import { getEnv } from './env.mjs'

function generateOutTradeNo() {
  const now = new Date()
  const date = now.toISOString().slice(0, 10).replace(/-/g, '')
  const rand = crypto.randomBytes(6).toString('hex')
  return `WX${date}${rand}`
}

export async function createUnifiedOrder({ openid, totalFee, description }) {
  const appid = getEnv('WX_APPID')
  const mchId = getEnv('WX_MCH_ID')
  const mchKey = getEnv('WX_MCH_KEY')
  const notifyUrl = getEnv('WX_PAY_NOTIFY_URL')

  if (!mchId || !mchKey) {
    throw Object.assign(new Error('微信支付未配置'), { code: 'WX_PAY_NOT_CONFIGURED' })
  }

  const outTradeNo = generateOutTradeNo()

  const body = {
    appid,
    mchid: mchId,
    description: description || '面试逐字稿生成器 - 使用次数',
    out_trade_no: outTradeNo,
    notify_url: notifyUrl,
    amount: {
      total: totalFee,
      currency: 'CNY',
    },
    payer: {
      openid,
    },
  }

  // NOTE: Production needs proper WeChat Pay V3 signature with merchant private key.
  // This returns the structure needed; the actual API call requires signing.
  return {
    outTradeNo,
    body,
  }
}

export function getPaymentParams(prepayId) {
  const appid = getEnv('WX_APPID')
  const mchKey = getEnv('WX_MCH_KEY')
  const timestamp = String(Math.floor(Date.now() / 1000))
  const nonceStr = crypto.randomBytes(16).toString('hex')

  const message = `${appid}\n${timestamp}\n${nonceStr}\nprepay_id=${prepayId}\n`

  const paySign = crypto
    .createHmac('sha256', mchKey)
    .update(message)
    .digest('hex')
    .toUpperCase()

  return {
    timeStamp: timestamp,
    nonceStr,
    package: `prepay_id=${prepayId}`,
    signType: 'HMAC-SHA256',
    paySign,
  }
}

export function parsePayNotification(body) {
  if (!body || !body.resource) {
    return null
  }

  return {
    outTradeNo: body.resource?.out_trade_no,
    transactionId: body.resource?.transaction_id,
    tradeState: body.resource?.trade_state,
  }
}
