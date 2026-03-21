import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

const processes = [
  spawn(process.execPath, ['server/index.mjs'], {
    cwd: rootDir,
    env: {
      ...process.env,
      NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY || '1',
    },
    stdio: 'inherit',
  }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], {
    cwd: rootDir,
    stdio: 'inherit',
  }),
]

let shuttingDown = false

function shutdown(signal = 'SIGTERM') {
  if (shuttingDown) return
  shuttingDown = true

  for (const child of processes) {
    if (!child.killed) {
      child.kill(signal)
    }
  }
}

for (const child of processes) {
  child.on('exit', (code) => {
    shutdown()
    if (code && code !== 0) {
      process.exitCode = code
    }
  })
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
