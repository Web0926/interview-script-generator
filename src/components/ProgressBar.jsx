import { colors, fonts } from '../styles/theme.js'

const steps = ['上传简历', 'AI 分析', '深度问答', '生成逐字稿']

const stepIndex = { upload: 0, analyzing: 1, qa: 2, generating: 3, result: 3 }

export default function ProgressBar({ step }) {
  const current = stepIndex[step] ?? 0

  return (
    <div style={{ padding: '20px 24px 0', maxWidth: '760px', margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
        {steps.map((label, i) => {
          const done = i < current
          const active = i === current
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', flex: i < steps.length - 1 ? 1 : 'none' }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px' }}>
                <div
                  style={{
                    width: '28px',
                    height: '28px',
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '12px',
                    fontFamily: fonts.sans,
                    fontWeight: 600,
                    transition: 'all 0.3s ease',
                    background: done ? colors.primary : active ? colors.primary : '#ede7df',
                    color: done || active ? '#fff' : colors.textMuted,
                    boxShadow: active ? `0 0 0 3px ${colors.primary}30` : 'none',
                  }}
                >
                  {done ? '✓' : i + 1}
                </div>
                <span
                  style={{
                    fontSize: '11px',
                    fontFamily: fonts.sans,
                    color: active ? colors.primary : done ? colors.textSecondary : colors.textMuted,
                    fontWeight: active ? 600 : 400,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {label}
                </span>
              </div>
              {i < steps.length - 1 && (
                <div
                  style={{
                    flex: 1,
                    height: '2px',
                    margin: '-14px 8px 0',
                    background: i < current ? colors.primary : '#ede7df',
                    transition: 'background 0.3s ease',
                  }}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
