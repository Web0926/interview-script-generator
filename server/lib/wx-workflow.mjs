import crypto from 'node:crypto'
import { withWxState, readWxState } from './wx-store.mjs'
import { withState, readState } from './store.mjs'
import { code2Session, generateUserToken } from './wx-auth.mjs'

const SESSION_TTL_HOURS = 24

function nowIso() {
  return new Date().toISOString()
}

function addHours(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString()
}

export async function wxLogin(jsCode) {
  const wxResult = await code2Session(jsCode)
  const { openid } = wxResult

  return withWxState(({ usersStore }) => {
    const timestamp = nowIso()
    let user = usersStore.users.find((u) => u.openid === openid)

    if (!user) {
      user = {
        id: usersStore.nextId++,
        openid,
        token: generateUserToken(),
        remainingSessions: 0,
        totalPurchased: 0,
        totalUsed: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      usersStore.users.push(user)
    } else {
      user.token = generateUserToken()
      user.updatedAt = timestamp
    }

    return {
      ok: true,
      token: user.token,
      user: {
        id: user.id,
        remainingSessions: user.remainingSessions,
        totalPurchased: user.totalPurchased,
        totalUsed: user.totalUsed,
      },
    }
  })
}

export async function getWxUser(token) {
  if (!token) return null
  const { usersStore } = await readWxState()
  return usersStore.users.find((u) => u.token === token) || null
}

export async function getWxUserInfo(token) {
  const user = await getWxUser(token)
  if (!user) {
    return { ok: false, code: 'WX_INVALID_TOKEN' }
  }

  return {
    ok: true,
    user: {
      id: user.id,
      remainingSessions: user.remainingSessions,
      totalPurchased: user.totalPurchased,
      totalUsed: user.totalUsed,
    },
  }
}

export async function createPayOrder(token) {
  const user = await getWxUser(token)
  if (!user) {
    return { ok: false, code: 'WX_INVALID_TOKEN' }
  }

  return withWxState(({ wxOrdersStore }) => {
    const timestamp = nowIso()
    const outTradeNo = `WX${Date.now()}${crypto.randomBytes(4).toString('hex')}`

    const order = {
      id: wxOrdersStore.nextId++,
      userId: user.id,
      outTradeNo,
      prepayId: null,
      totalFee: 990,
      status: 'pending',
      paidAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    wxOrdersStore.orders.push(order)

    return {
      ok: true,
      order: {
        id: order.id,
        outTradeNo: order.outTradeNo,
        totalFee: order.totalFee,
      },
      openid: user.openid,
    }
  })
}

export async function handlePaymentSuccess(outTradeNo) {
  return withWxState(({ usersStore, wxOrdersStore }) => {
    const order = wxOrdersStore.orders.find((o) => o.outTradeNo === outTradeNo)
    if (!order) return { ok: false, code: 'ORDER_NOT_FOUND' }
    if (order.status === 'paid') return { ok: true, alreadyProcessed: true }

    const user = usersStore.users.find((u) => u.id === order.userId)
    if (!user) return { ok: false, code: 'USER_NOT_FOUND' }

    const timestamp = nowIso()
    order.status = 'paid'
    order.paidAt = timestamp
    order.updatedAt = timestamp

    user.remainingSessions += 1
    user.totalPurchased += 1
    user.updatedAt = timestamp

    return { ok: true }
  })
}

async function findActiveWxSession(wxUserId, clientId) {
  const { sessionsStore } = await readState()

  const session = sessionsStore.sessions
    .filter((s) => s.wxUserId === wxUserId)
    .sort((a, b) => b.id - a.id)
    .find((s) => {
      if (s.status === 'completed' || s.status === 'expired') return false
      if (s.expiresAt && new Date(s.expiresAt).getTime() <= Date.now()) return false
      return s.status === 'active' || s.status === 'processing'
    })

  if (!session) return null

  if (session.clientId !== clientId) {
    return { ok: false, code: 'ORDER_ALREADY_CLAIMED' }
  }

  return {
    ok: true,
    sessionToken: session.sessionToken,
    session: {
      currentStep: session.currentStep,
      sessionStatus: session.status,
      analysisResult: session.analysisResult ?? null,
      scriptsResult: session.scriptsResult ?? null,
      lastError: session.lastError ?? null,
      expiresAt: session.expiresAt,
    },
  }
}

export async function startWxSession(token, clientId) {
  const user = await getWxUser(token)
  if (!user) {
    return { ok: false, code: 'WX_INVALID_TOKEN' }
  }

  if (!clientId || String(clientId).trim().length < 12) {
    return { ok: false, code: 'INVALID_CLIENT_ID' }
  }

  const existingResult = await findActiveWxSession(user.id, clientId)
  if (existingResult) {
    return existingResult
  }

  if (user.remainingSessions <= 0) {
    return { ok: false, code: 'WX_NO_REMAINING_SESSIONS' }
  }

  // Decrement remaining sessions
  await withWxState(({ usersStore }) => {
    const u = usersStore.users.find((u2) => u2.id === user.id)
    if (u) {
      u.remainingSessions -= 1
      u.totalUsed += 1
      u.updatedAt = nowIso()
    }
  })

  // Create session in the existing sessions store
  return withState(({ sessionsStore }) => {
    const timestamp = nowIso()
    const session = {
      id: sessionsStore.nextId++,
      orderId: null,
      wxUserId: user.id,
      clientId,
      sessionToken: crypto.randomUUID(),
      status: 'active',
      currentStep: 'upload',
      resumeInput: null,
      resumeMediaType: null,
      resumeBase64: null,
      analysisResult: null,
      scriptsResult: null,
      lastError: null,
      expiresAt: addHours(SESSION_TTL_HOURS),
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    sessionsStore.sessions.push(session)

    return {
      ok: true,
      sessionToken: session.sessionToken,
      session: {
        currentStep: session.currentStep,
        sessionStatus: session.status,
        analysisResult: null,
        scriptsResult: null,
        lastError: null,
        expiresAt: session.expiresAt,
      },
    }
  })
}
