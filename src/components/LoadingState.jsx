import { colors, fonts } from '../styles/theme.js'

export default function LoadingState({ message = 'AI 正在分析你的简历…', submessage }) {
  return (
    <div
      className="fade-in-up"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '80px 24px',
        gap: '24px',
      }}
    >
      {/* Spinner */}
      <div
        style={{
          width: '52px',
          height: '52px',
          borderRadius: '50%',
          border: `3px solid ${colors.border}`,
          borderTopColor: colors.primary,
          animation: 'spin 0.9s linear infinite',
        }}
      />

      <div style={{ textAlign: 'center', maxWidth: '320px' }}>
        <p style={{ fontFamily: fonts.serif, fontSize: '17px', color: colors.text, fontWeight: 500, marginBottom: '8px' }}>
          {message}
        </p>
        {submessage && (
          <p style={{ fontFamily: fonts.sans, fontSize: '13px', color: colors.textMuted }}>
            {submessage}
          </p>
        )}
      </div>

      {/* Shimmer bar */}
      <div
        style={{
          width: '240px',
          height: '4px',
          borderRadius: '2px',
          overflow: 'hidden',
          background: colors.border,
        }}
      >
        <div
          style={{
            width: '100%',
            height: '100%',
            background: `linear-gradient(90deg, transparent 0%, ${colors.primary} 50%, transparent 100%)`,
            backgroundSize: '200% 100%',
            animation: 'shimmer 1.6s infinite',
          }}
        />
      </div>
    </div>
  )
}
