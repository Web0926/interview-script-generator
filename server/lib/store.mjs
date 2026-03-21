import fs from 'node:fs/promises'
import path from 'node:path'
import { getRootDir } from './env.mjs'

const rootDir = getRootDir()
const dataDir = path.join(rootDir, 'server/data')
const ordersFile = path.join(dataDir, 'orders.json')
const sessionsFile = path.join(dataDir, 'sessions.json')

let queue = Promise.resolve()

function defaultOrdersStore() {
  return { nextId: 1, orders: [] }
}

function defaultSessionsStore() {
  return { nextId: 1, sessions: [] }
}

async function ensureFile(filePath, fallback) {
  try {
    await fs.access(filePath)
  } catch {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, JSON.stringify(fallback, null, 2))
  }
}

async function readJson(filePath, fallback) {
  await ensureFile(filePath, fallback)
  const content = await fs.readFile(filePath, 'utf8')
  return JSON.parse(content)
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2))
}

function withLock(task) {
  const next = queue.then(task, task)
  queue = next.catch(() => {})
  return next
}

export async function withState(task) {
  return withLock(async () => {
    const ordersStore = await readJson(ordersFile, defaultOrdersStore())
    const sessionsStore = await readJson(sessionsFile, defaultSessionsStore())
    const result = await task({ ordersStore, sessionsStore })
    await writeJson(ordersFile, ordersStore)
    await writeJson(sessionsFile, sessionsStore)
    return result
  })
}

export async function readState() {
  return withLock(async () => {
    const ordersStore = await readJson(ordersFile, defaultOrdersStore())
    const sessionsStore = await readJson(sessionsFile, defaultSessionsStore())
    return { ordersStore, sessionsStore }
  })
}
