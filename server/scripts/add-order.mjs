import { upsertPaidOrder } from '../lib/workflow.mjs'

function readArg(name) {
  const prefix = `--${name}=`
  const value = process.argv.find((item) => item.startsWith(prefix))
  return value ? value.slice(prefix.length) : ''
}

const orderNo = readArg('orderNo')
const phoneLast4 = readArg('phoneLast4')
const amount = readArg('amount')

if (!orderNo || !phoneLast4) {
  console.error('用法: npm run add-order -- --orderNo=XHS123 --phoneLast4=1234 [--amount=1999]')
  process.exit(1)
}

try {
  const order = await upsertPaidOrder({
    orderNo,
    phoneLast4,
    amountCents: amount ? Number(amount) : null,
  })

  console.log(`已写入订单 ${order.orderNo}，手机号后四位 ${order.phoneLast4}`)
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
