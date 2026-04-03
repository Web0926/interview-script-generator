import crypto from 'node:crypto'
import { getEnv } from './env.mjs'

const WX_CODE2SESSION_URL = 'https://api.weixin.qq.com/sns/jscode2session'

export function isWxConfigured() {
  return Boolean(getEnv('WX_APPID') && getEnv('WX_SECRET'))
}

export async function code2Session(jsCode) {
  const appid = getEnv('WX_APPID')
  const secret = getEnv('WX_SECRET')
  if (!appid || !secret) {
    throw Object.assign(new Error('微信小程序未配置'), { code: 'WX_NOT_CONFIGURED' })
  }

  const url = `${WX_CODE2SESSION_URL}?appid=${appid}&secret=${secret}&js_code=${encodeURIComponent(jsCode)}&grant_type=authorization_code`

  const res = await fetch(url)
  const data = await res.json()

  if (data.errcode) {
    console.error('[wx-auth] code2Session failed', JSON.stringify({ errcode: data.errcode, errmsg: data.errmsg }))
    throw Object.assign(new Error(data.errmsg || '微信登录失败'), { code: 'WX_LOGIN_FAILED' })
  }

  return {
    openid: data.openid,
    sessionKey: data.session_key,
    unionid: data.unionid || null,
  }
}

export function generateUserToken() {
  return crypto.randomUUID()
}
