import fs from 'node:fs/promises'
import path from 'node:path'
import { getRootDir } from './env.mjs'

const rootDir = getRootDir()
const dataDir = path.join(rootDir, 'server/data')
const usersFile = path.join(dataDir, 'wx-users.json')
const wxOrdersFile = path.join(dataDir, 'wx-orders.json')

let queue = Promise.resolve()

function defaultUsersStore() {
  return { nextId: 1, users: [] }
}

function defaultWxOrdersStore() {
  return { nextId: 1, orders: [] }
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

export async function withWxState(task) {
  return withLock(async () => {
    const usersStore = await readJson(usersFile, defaultUsersStore())
    const wxOrdersStore = await readJson(wxOrdersFile, defaultWxOrdersStore())
    const result = await task({ usersStore, wxOrdersStore })
    await writeJson(usersFile, usersStore)
    await writeJson(wxOrdersFile, wxOrdersStore)
    return result
  })
}

export async function readWxState() {
  return withLock(async () => {
    const usersStore = await readJson(usersFile, defaultUsersStore())
    const wxOrdersStore = await readJson(wxOrdersFile, defaultWxOrdersStore())
    return { usersStore, wxOrdersStore }
  })
}
