import { useState } from 'react'
import { colors, fonts, radius, shadow, card } from '../styles/theme.js'

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    const plain = text.replace(/\n\n/g, '\n\n')
    await navigator.clipboard.writeText(plain)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <button
      onClick={handleCopy}
      style={{
        padding: '8px 18px',
        borderRadius: radius.sm,
        border: `1px solid ${copied ? colors.success : colors.border}`,
        background: copied ? `${colors.success}10` : colors.bg,
        color: copied ? colors.success : colors.textSecondary,
        fontFamily: fonts.sans,
        fontSize: '13px',
        fontWeight: 500,
        cursor: 'pointer',
        transition: 'all 0.2s ease',
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
      }}
    >
      {copied ? '✓ 已复制' : '📋 一键复制'}
    </button>
  )
}

function CollapseSection({ title, children }) {
  const [open, setOpen] = useState(false)

  return (
    <div style={{ marginTop: '16px', borderTop: `1px solid ${colors.border}`, paddingTop: '16px' }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          fontFamily: fonts.sans,
          fontSize: '13px',
          fontWeight: 600,
          color: colors.textSecondary,
          padding: 0,
        }}
      >
        <span style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s', display: 'inline-block' }}>▶</span>
        {title}
      </button>
      {open && (
        <div style={{ marginTop: '12px', paddingLeft: '4px' }} className="fade-in-up">
          {children}
        </div>
      )}
    </div>
  )
}

function ScriptCard({ data, index }) {
  const accentColors = [colors.primary, '#5b6abf']
  const accent = accentColors[index] || colors.primary

  const paragraphs = data.script.split('\n\n').filter(Boolean)

  return (
    <div
      className="fade-in-up"
      style={{
        ...card,
        boxShadow: shadow.md,
        borderTop: `3px solid ${accent}`,
        animationDelay: `${index * 0.1}s`,
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '20px' }}>
        <div>
          <h3 style={{ fontFamily: fonts.serif, fontSize: '19px', fontWeight: 700, color: colors.text, marginBottom: '4px' }}>
            {data.title}
            {data.project_name && (
              <span style={{ fontFamily: fonts.sans, fontSize: '13px', fontWeight: 400, color: colors.textMuted, marginLeft: '10px' }}>
                {data.project_name}
              </span>
            )}
          </h3>
          <span
            style={{
              display: 'inline-block',
              padding: '2px 10px',
              borderRadius: '10px',
              background: accent + '15',
              color: accent,
              fontFamily: fonts.sans,
              fontSize: '12px',
              fontWeight: 600,
            }}
          >
            {data.duration}
          </span>
        </div>
        <CopyButton text={data.script} />
      </div>

      {/* Script body */}
      <div
        style={{
          background: colors.bgSubtle,
          borderRadius: radius.md,
          padding: '20px',
          borderLeft: `3px solid ${accent}40`,
        }}
      >
        {paragraphs.map((p, i) => (
          <p
            key={i}
            style={{
              fontFamily: fonts.sans,
              fontSize: '15px',
              color: colors.text,
              lineHeight: 1.9,
              marginBottom: i < paragraphs.length - 1 ? '16px' : 0,
            }}
          >
            {p}
          </p>
        ))}
      </div>

      {/* Structure notes */}
      <CollapseSection title="表达结构拆解">
        <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {data.structure_notes.map((note, i) => (
            <li key={i} style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
              <span
                style={{
                  width: '20px',
                  height: '20px',
                  borderRadius: '50%',
                  background: accent + '20',
                  color: accent,
                  fontFamily: fonts.sans,
                  fontSize: '11px',
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  marginTop: '2px',
                }}
              >
                {i + 1}
              </span>
              <span style={{ fontFamily: fonts.sans, fontSize: '13px', color: colors.textSecondary, lineHeight: 1.7 }}>
                {note}
              </span>
            </li>
          ))}
        </ul>
      </CollapseSection>

      {/* Practice tips */}
      <CollapseSection title="练习建议">
        <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {data.tips.map((tip, i) => (
            <li key={i} style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
              <span style={{ color: accent, fontSize: '14px', flexShrink: 0, marginTop: '1px' }}>◆</span>
              <span style={{ fontFamily: fonts.sans, fontSize: '13px', color: colors.textSecondary, lineHeight: 1.7 }}>
                {tip}
              </span>
            </li>
          ))}
        </ul>
      </CollapseSection>
    </div>
  )
}

export default function ScriptResult({ scripts, onRestart, restartLabel = '重新开始' }) {
  return (
    <div style={{ maxWidth: '720px', margin: '0 auto', padding: '32px 24px' }}>
      <div className="fade-in-up" style={{ marginBottom: '28px', textAlign: 'center' }}>
        <div style={{ fontSize: '36px', marginBottom: '12px' }}>🎉</div>
        <h2 style={{ fontFamily: fonts.serif, fontSize: '22px', fontWeight: 700, color: colors.text, marginBottom: '6px' }}>
          表达稿已生成
        </h2>
        <p style={{ fontFamily: fonts.sans, fontSize: '14px', color: colors.textMuted }}>
          以下内容基于你的简历和回答整理而成，建议先理解结构，再练到表达自然
        </p>
        <p style={{ fontFamily: fonts.sans, fontSize: '13px', color: colors.textMuted, marginTop: '8px', lineHeight: 1.7 }}>
          不需要背出“表演感”，重点是把事实、判断和复盘顺着讲清楚。
        </p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
        <ScriptCard data={scripts.self_intro} index={0} />
        <ScriptCard data={scripts.project_intro} index={1} />
      </div>

      <div style={{ textAlign: 'center', marginTop: '36px' }}>
        <button
          onClick={onRestart}
          style={{
            padding: '12px 32px',
            borderRadius: radius.md,
            border: `1.5px solid ${colors.border}`,
            background: 'transparent',
            color: colors.textSecondary,
            fontFamily: fonts.sans,
            fontSize: '14px',
            fontWeight: 500,
            cursor: 'pointer',
            transition: 'all 0.2s ease',
          }}
          onMouseEnter={(e) => { e.target.style.borderColor = colors.primary; e.target.style.color = colors.primary }}
          onMouseLeave={(e) => { e.target.style.borderColor = colors.border; e.target.style.color = colors.textSecondary }}
        >
          {restartLabel}
        </button>
      </div>
    </div>
  )
}
