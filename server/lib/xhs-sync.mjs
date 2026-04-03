import fs from 'node:fs'
import path from 'node:path'
import { getRootDir } from './env.mjs'
import { isConfigured, getOrderList, getOrderDetail } from './xhs-client.mjs'
import { upsertPaidOrder } from './workflow.mjs'

const SYNC_STATE_FILE = path.join(getRootDir(), 'server/data/xhs-sync-state.json')
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000
const LOOKBACK_MS = 30 * 60 * 1000

// ─── Sync state persistence ────────────────────────────────────────

function readSyncState() {
  try {
    if (fs.existsSync(SYNC_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(SYNC_STATE_FILE, 'utf8'))
    }
  } catch { /* ignore */ }
  return {
    lastSyncTime: null,
    lastSyncResult: null,
    totalSynced: 0,
    totalErrors: 0,
  }
}

function writeSyncState(state) {
  const dir = path.dirname(SYNC_STATE_FILE)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(SYNC_STATE_FILE, JSON.stringify(state, null, 2))
}

// ─── Core sync logic ───────────────────────────────────────────────

let syncRunning = false
let syncTimer = null
let syncState = null

function toXHSTimeString(date) {
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
}

function extractPhoneLast4(orderDetail) {
  const phone = orderDetail?.receiver_phone
    || orderDetail?.buyer_phone
    || orderDetail?.phone
    || ''

  const digits = String(phone).replace(/\D/g, '')
  if (digits.length >= 4) {
    return digits.slice(-4)
  }

  return null
}

function extractAmountCents(order) {
  const amount = order?.total_amount || order?.pay_amount || order?.actual_amount
  if (amount === undefined || amount === null) return null

  const num = Number(amount)
  if (Number.isNaN(num)) return null

  if (num < 100) return Math.round(num * 100)
  return Math.round(num)
}

export async function syncNewOrders() {
  if (syncRunning) {
    console.log('[xhs.sync] skip: previous sync still running')
    return { synced: 0, errors: 0, skipped: true }
  }

  if (!isConfigured()) {
    return { synced: 0, errors: 0, skipped: true, reason: 'not configured' }
  }

  syncRunning = true
  if (!syncState) syncState = readSyncState()

  const now = new Date()
  const startTime = syncState.lastSyncTime
    ? new Date(new Date(syncState.lastSyncTime).getTime() - LOOKBACK_MS)
    : new Date(now.getTime() - 24 * 60 * 60 * 1000)

  console.log('[xhs.sync] start', JSON.stringify({
    from: startTime.toISOString(),
    to: now.toISOString(),
  }))

  let synced = 0
  let errors = 0
  let pageNo = 1

  try {
    while (true) {
      let result
      try {
        result = await getOrderList({
          startTime: toXHSTimeString(startTime),
          endTime: toXHSTimeString(now),
          pageNo,
          pageSize: 50,
        })
      } catch (error) {
        console.error('[xhs.sync] getOrderList failed', error.message)
        errors++
        break
      }

      if (!result.orders.length) break

      for (const order of result.orders) {
        const orderNo = order.order_no || order.orderNo
        if (!orderNo) {
          errors++
          continue
        }

        try {
          let phoneLast4 = null

          try {
            const detail = await getOrderDetail(orderNo)
            phoneLast4 = extractPhoneLast4(detail)
          } catch (detailError) {
            console.warn(`[xhs.sync] getOrderDetail failed for ${orderNo}:`, detailError.message)
          }

          if (!phoneLast4) {
            phoneLast4 = extractPhoneLast4(order)
          }

          if (!phoneLast4) {
            console.warn(`[xhs.sync] no phone for order ${orderNo}, skipping`)
            errors++
            continue
          }

          const amountCents = extractAmountCents(order)

          await upsertPaidOrder({ orderNo, phoneLast4, amountCents })
          synced++

          console.log('[xhs.sync] new order', JSON.stringify({
            orderNo,
            phoneTail: phoneLast4,
            amount: amountCents,
          }))
        } catch (orderError) {
          console.error(`[xhs.sync] failed to process order ${orderNo}:`, orderError.message)
          errors++
        }
      }

      if (!result.hasMore) break
      pageNo++
    }

    syncState.lastSyncTime = now.toISOString()
    syncState.lastSyncResult = {
      synced,
      errors,
      timestamp: now.toISOString(),
    }
    syncState.totalSynced += synced
    syncState.totalErrors += errors
    writeSyncState(syncState)

    console.log('[xhs.sync] done', JSON.stringify({ synced, errors }))
  } catch (error) {
    console.error('[xhs.sync] unexpected error:', error.message)
    errors++
  } finally {
    syncRunning = false
  }

  return { synced, errors, skipped: false }
}

// ─── Periodic sync ─────────────────────────────────────────────────

export function startPeriodicSync(intervalMs = DEFAULT_INTERVAL_MS) {
  if (syncTimer) {
    console.log('[xhs.sync] periodic sync already running')
    return
  }

  syncTimer = setInterval(async () => {
    try {
      await syncNewOrders()
    } catch (error) {
      console.error('[xhs.sync] periodic sync error:', error.message)
    }
  }, intervalMs)

  setTimeout(() => {
    syncNewOrders().catch((error) => {
      console.error('[xhs.sync] initial sync error:', error.message)
    })
  }, 5_000)

  console.log(`[xhs.sync] periodic sync started (every ${Math.round(intervalMs / 60_000)} min)`)
}

export function stopPeriodicSync() {
  if (syncTimer) {
    clearInterval(syncTimer)
    syncTimer = null
    console.log('[xhs.sync] periodic sync stopped')
  }
}

// ─── Status ────────────────────────────────────────────────────────

export function getSyncStatus() {
  const state = syncState || readSyncState()
  return {
    configured: isConfigured(),
    running: syncRunning,
    periodicActive: syncTimer !== null,
    lastSyncTime: state.lastSyncTime,
    lastSyncResult: state.lastSyncResult,
    totalSynced: state.totalSynced,
    totalErrors: state.totalErrors,
  }
}
