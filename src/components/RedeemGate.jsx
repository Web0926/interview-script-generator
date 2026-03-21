import { useState } from 'react'
import { colors, fonts, radius, shadow, card } from '../styles/theme.js'

export default function RedeemGate({ onRedeem }) {
  const [orderNo, setOrderNo] = useState('')
  const [phoneLast4, setPhoneLast4] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()

    const normalizedOrderNo = orderNo.trim()
    const normalizedPhone = phoneLast4.replace(/\D/g, '').slice(-4)

    if (!normalizedOrderNo) {
      setError('请先填写小红书订单号')
      return
    }

    if (normalizedPhone.length !== 4) {
      setError('请输入下单手机号后四位')
      return
    }

    setSubmitting(true)
    setError('')

    try {
      await onRedeem({
        orderNo: normalizedOrderNo,
        phoneLast4: normalizedPhone,
      })
    } catch (submitError) {
      setError(submitError.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fade-in-up" style={{ maxWidth: '560px', margin: '0 auto', padding: '40px 24px' }}>
      <div style={{ ...card, boxShadow: shadow.md }}>
        <div style={{ marginBottom: '24px' }}>
          <h2
            style={{
              fontFamily: fonts.serif,
              fontSize: '24px',
              color: colors.text,
              marginBottom: '8px',
              fontWeight: 700,
            }}
          >
            兑换一次使用机会
          </h2>
          <p style={{ fontFamily: fonts.sans, fontSize: '14px', color: colors.textMuted, lineHeight: 1.8 }}>
            请填写小红书订单号和下单手机号后四位。兑换成功后会直接进入简历上传流程，直到逐字稿生成成功才会消耗这次机会。
          </p>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <span style={{ fontFamily: fonts.sans, fontSize: '13px', color: colors.textSecondary, fontWeight: 600 }}>
              小红书订单号
            </span>
            <input
              value={orderNo}
              onChange={(e) => setOrderNo(e.target.value)}
              placeholder="例如：XHS202603180001"
              autoComplete="off"
              style={{
                width: '100%',
                padding: '14px 16px',
                borderRadius: radius.md,
                border: `1.5px solid ${colors.border}`,
                background: colors.bg,
                color: colors.text,
                fontFamily: fonts.sans,
                fontSize: '14px',
                outline: 'none',
              }}
            />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <span style={{ fontFamily: fonts.sans, fontSize: '13px', color: colors.textSecondary, fontWeight: 600 }}>
              下单手机号后四位
            </span>
            <input
              value={phoneLast4}
              onChange={(e) => setPhoneLast4(e.target.value.replace(/\D/g, '').slice(-4))}
              placeholder="例如：1234"
              inputMode="numeric"
              autoComplete="off"
              style={{
                width: '100%',
                padding: '14px 16px',
                borderRadius: radius.md,
                border: `1.5px solid ${colors.border}`,
                background: colors.bg,
                color: colors.text,
                fontFamily: fonts.sans,
                fontSize: '14px',
                outline: 'none',
                letterSpacing: '0.2em',
              }}
            />
          </label>

          {error && (
            <div
              style={{
                padding: '12px 14px',
                borderRadius: radius.md,
                background: colors.errorBg,
                color: colors.error,
                fontFamily: fonts.sans,
                fontSize: '13px',
                lineHeight: 1.7,
              }}
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            style={{
              marginTop: '4px',
              width: '100%',
              padding: '14px',
              borderRadius: radius.md,
              border: 'none',
              background: submitting ? colors.border : colors.primary,
              color: submitting ? colors.textMuted : '#fff',
              fontFamily: fonts.sans,
              fontSize: '15px',
              fontWeight: 600,
              cursor: submitting ? 'not-allowed' : 'pointer',
              boxShadow: submitting ? 'none' : shadow.sm,
            }}
          >
            {submitting ? '校验订单中…' : '立即兑换'}
          </button>
        </form>

        <div
          style={{
            marginTop: '18px',
            paddingTop: '18px',
            borderTop: `1px solid ${colors.border}`,
            fontFamily: fonts.sans,
            fontSize: '12px',
            color: colors.textMuted,
            lineHeight: 1.8,
          }}
        >
          如果你已经兑换过一次，请回到首次兑换的设备继续使用。同一笔订单只支持一个有效会话。
        </div>
      </div>
    </div>
  )
}
