import http from 'node:http'
import { getAuthUrl, exchangeCodeForToken, getTokenStatus } from '../lib/xhs-client.mjs'
import { getEnv } from '../lib/env.mjs'

const CALLBACK_PORT = 9876

const appKey = getEnv('XHS_APP_KEY')
const appSecret = getEnv('XHS_APP_SECRET')

if (!appKey || !appSecret) {
  console.error('错误：请先在 .env 文件中配置 XHS_APP_KEY 和 XHS_APP_SECRET\n')
  console.error('  XHS_APP_KEY=你的AppKey')
  console.error('  XHS_APP_SECRET=你的AppSecret\n')
  console.error('获取方式：')
  console.error('  1. 访问 https://open.xiaohongshu.com/ 注册开发者')
  console.error('  2. 创建应用，获取 App Key 和 App Secret')
  console.error('  3. 申请"订单查询"API 权限')
  process.exit(1)
}

// Check existing token status
const status = getTokenStatus()
if (status.valid) {
  console.log(`当前 token 有效（剩余 ${status.expiresIn} 分钟）`)
  console.log('如需重新授权，请删除 server/data/xhs-tokens.json 后重试')
  process.exit(0)
}

console.log('=== 小红书开放平台 OAuth 授权 ===\n')

const authUrl = getAuthUrl()

console.log('步骤 1：在浏览器中打开以下链接并完成授权：\n')
console.log(`  ${authUrl}\n`)
console.log('步骤 2：授权完成后，小红书会跳转到回调地址。')
console.log('        请复制回调 URL 中的 code 参数。\n')
console.log('步骤 3：在下面的提示中输入 code，或者：')
console.log(`        如果你的回调地址是 http://localhost:${CALLBACK_PORT}/callback`)
console.log('        系统会自动接收 code。\n')
console.log('正在监听回调...\n')

// Start callback server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`)

  if (url.pathname === '/callback') {
    const code = url.searchParams.get('code')

    if (!code) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<h2>缺少 code 参数</h2>')
      return
    }

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<h2>授权成功！请回到终端查看结果。</h2><p>此页面可以关闭。</p>')

    await handleCode(code)
    server.close()
    process.exit(0)
  }

  res.writeHead(404)
  res.end()
})

server.listen(CALLBACK_PORT, () => {
  console.log(`回调服务器已启动: http://localhost:${CALLBACK_PORT}/callback`)
  console.log('等待授权回调...\n')
})

// Also accept code from stdin
process.stdin.setEncoding('utf8')
console.log('或者直接粘贴 code 并按回车：')

let stdinBuffer = ''
process.stdin.on('data', async (chunk) => {
  stdinBuffer += chunk
  const lines = stdinBuffer.split('\n')
  if (lines.length < 2) return

  const code = lines[0].trim()
  if (!code) return

  stdinBuffer = ''
  await handleCode(code)
  server.close()
  process.exit(0)
})

async function handleCode(code) {
  console.log(`\n收到 code: ${code.slice(0, 8)}...`)
  console.log('正在交换 access token...\n')

  try {
    const tokens = await exchangeCodeForToken(code)
    console.log('授权成功！Token 已保存到 server/data/xhs-tokens.json\n')
    console.log(`  Access Token 有效期至: ${new Date(tokens.expiresAt).toLocaleString()}`)
    console.log(`  Refresh Token 有效期至: ${new Date(tokens.refreshExpiresAt).toLocaleString()}`)
    console.log('\n系统会在 token 过期前自动刷新，无需手动操作。')
    console.log('现在可以启动服务器，订单将自动同步。')
  } catch (error) {
    console.error('授权失败:', error.message)
    process.exit(1)
  }
}

// Timeout after 5 minutes
setTimeout(() => {
  console.log('\n等待超时（5分钟），请重新运行 npm run xhs-auth')
  server.close()
  process.exit(1)
}, 5 * 60 * 1000)
