import { useState, useEffect, useRef } from 'react'
import { colors, fonts, radius, shadow, card } from '../styles/theme.js'

const DIMENSION_COLORS = {
  '关键切入点': '#e8763a',
  '结果与个人作用': '#4a7c59',
  '判断与取舍': '#5b6abf',
  '复盘与修正': '#8e5ab5',
  '岗位匹配与主线': '#b4783c',
}

const FALLBACK_OPTIONS = {
  '关键切入点': [
    '我是先从漏斗数据里看到异常的（例如首页UV CTR只有 xx%，而同类首页入口常见在 xx%-xx%）',
    '我先注意到用户到了首页后不知道下一步该做什么（比如停留有 x 秒，但点击下一步动作的人仅有 xx%）',
    '我先从用户行为现象里确认这不是单点问题（例如人均浏览入口数为 x.x，但最终转化率仅为 x%）',
    '当时最明显的问题是首页表达不统一（首页推荐卡同意图 Query 召回重复率有 xx%，用户很难快速判断该点哪一个）',
  ],
  '结果与个人作用': [
    '我先把曝光到转化的漏斗拆开看了一遍（曝光→点击→落地页→下游动作，各环节转化率分别是 xx% / xx% / xx%）',
    '我主导定位了最关键的瓶颈环节（点击率本身有 xx%，但点击后进入落地页/下一步动作的转化只有 xx%，而同类链路常见在 xx%-xx%）',
    '我负责推动了实验设计和结果验证（核心指标看 CTR、互动率和下游转化）',
    '我不是只参与执行，我也做了判断和推进（包括拆指标、定优先级、推动实验）',
  ],
  '判断与取舍': [
    '当时桌面上其实不止一种方案（模板规则、人工配置、LLM生成都评估过）',
    '我优先选这条路是因为 ROI 更高（预期收益更明显，而且可以更快验证）',
    '我知道另一种方案更快，但长期效果一般（短期能上线，长期难支撑个性化）',
    '这个优先级是我结合实现成本、数据收益和上线节奏定的',
  ],
  '复盘与修正': [
    '我一开始的判断其实并不完全对（原来以为问题在入口，后来发现承接也有问题）',
    '有个实验结果和我预期相反（某个策略 CTR 提升了，但下游转化没有跟上）',
    '后来我调整了分群/策略/表达方式（不是继续堆功能，而是先改关键链路）',
    '这次偏差让我重新修正了方法论（以后我会先看核心转化，不只看表层点击）',
  ],
  '岗位匹配与主线': [
    '我下一步想继续做策略和产品结合更紧的方向',
    '前面的经历让我更明确自己擅长的是发现问题、拆解问题和推动落地',
    '这些经历里最能迁移的是问题判断、跨团队推进和实验验证能力',
    '我也知道自己接下来还要补一些能力，比如更完整的业务视角或行业认知',
  ],
}

function getSuggestedOptions(question) {
  if (Array.isArray(question.suggested_options) && question.suggested_options.length > 0) {
    return question.suggested_options
  }

  return FALLBACK_OPTIONS[question.dimension] || [
    '我可以先从当时看到的现象讲起',
    '我可以先讲我是怎么判断的',
    '我可以先讲我具体做了什么',
  ]
}

function getDisplayQuestion(question) {
  const raw = String(question.question || '').trim()
  if (!raw) return ''

  if (question.dimension === '关键切入点') {
    return raw
      .replace(/是从[^？]*？/g, '')
      .replace(/当时[^？]*？/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  }

  return raw
}

export default function QASession({ analysisResult, onComplete }) {
  const { resume_summary, candidate_name, questions } = analysisResult
  const [currentQ, setCurrentQ] = useState(0)
  const [answers, setAnswers] = useState([])
  const [draft, setDraft] = useState('')
  const [pressedOption, setPressedOption] = useState('')
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth))
  const textareaRef = useRef()
  const bottomRef = useRef()

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [currentQ])

  useEffect(() => {
    textareaRef.current?.focus()
  }, [currentQ])

  useEffect(() => {
    function handleResize() {
      setViewportWidth(window.innerWidth)
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  function handleKeyDown(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      submitAnswer()
    }
  }

  function appendOptionToDraft(option) {
    setDraft((current) => {
      const line = `- ${option}`
      const normalizedLines = current
        .split('\n')
        .map((item) => item.trim())
        .filter(Boolean)

      if (normalizedLines.includes(line)) {
        return current
      }

      if (!current.trim()) {
        return line
      }

      return `${current.trimEnd()}\n${line}`
    })

    setPressedOption(option)
    setTimeout(() => {
      setPressedOption((current) => (current === option ? '' : current))
    }, 220)

    requestAnimationFrame(() => {
      textareaRef.current?.focus()
    })
  }

  function submitAnswer() {
    const text = draft.trim()
    if (!text) return
    const q = questions[currentQ]
    const newAnswers = [...answers, {
      questionId: q.id,
      answer: text,
      selectedOptions: [],
      note: draft.trim(),
    }]
    setAnswers(newAnswers)
    setDraft('')
    setPressedOption('')

    if (currentQ < questions.length - 1) {
      setCurrentQ(currentQ + 1)
    } else {
      onComplete(newAnswers)
    }
  }

  const isLast = currentQ === questions.length - 1
  const currentQuestion = questions[currentQ]
  const canSubmit = Boolean(draft.trim())
  const suggestedOptions = getSuggestedOptions(currentQuestion)
  const displayQuestion = getDisplayQuestion(currentQuestion)
  const isNarrow = viewportWidth <= 420
  const isTabletDown = viewportWidth <= 768

  return (
    <div
      className="fade-in-up"
      style={{
        maxWidth: '680px',
        margin: '0 auto',
        padding: isNarrow ? '20px 14px 28px' : isTabletDown ? '28px 18px 32px' : '32px 24px',
      }}
    >

      {/* Resume summary card */}
      <div style={{ ...card, marginBottom: '28px', background: `${colors.primary}08`, border: `1px solid ${colors.primary}30` }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
          <div
            style={{
              width: '36px',
              height: '36px',
              borderRadius: '50%',
              background: colors.primary,
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '16px',
              flexShrink: 0,
            }}
          >
            ✦
          </div>
          <div>
            {candidate_name && (
              <p style={{ fontFamily: fonts.serif, fontSize: '15px', fontWeight: 600, color: colors.text, marginBottom: '4px' }}>
                {candidate_name}
              </p>
            )}
            <p style={{ fontFamily: fonts.sans, fontSize: '13px', color: colors.textSecondary, lineHeight: 1.7 }}>
              {resume_summary}
            </p>
          </div>
        </div>
      </div>

      {/* Completed Q&As */}
      {answers.map((ans, i) => {
        const q = questions[i]
        const dimColor = DIMENSION_COLORS[q.dimension] || colors.primary
        return (
          <div key={i} style={{ marginBottom: '20px', opacity: 0.75 }}>
            {/* Question bubble */}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', marginBottom: '10px' }}>
              <div
                style={{
                  padding: '2px 10px',
                  borderRadius: '12px',
                  background: dimColor + '18',
                  color: dimColor,
                  fontFamily: fonts.sans,
                  fontSize: '11px',
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                  marginTop: '2px',
                }}
              >
                {q.dimension}
              </div>
              <p style={{ fontFamily: fonts.sans, fontSize: '14px', color: colors.text, lineHeight: 1.7 }}>
                {q.question}
              </p>
            </div>
            {/* Answer bubble */}
            <div
              style={{
                marginLeft: '0',
                padding: '14px 16px',
                background: colors.bgSubtle,
                borderRadius: radius.md,
                borderLeft: `3px solid ${colors.border}`,
              }}
            >
              <p style={{ fontFamily: fonts.sans, fontSize: '13px', color: colors.textSecondary, lineHeight: 1.75, whiteSpace: 'pre-wrap' }}>
                {ans.answer}
              </p>
            </div>
          </div>
        )
      })}

      {/* Current question */}
      {currentQ < questions.length && (
        <div
          key={currentQ}
          className="fade-in-up"
          style={{
            ...card,
            padding: isNarrow ? '20px 16px' : card.padding,
            border: `1.5px solid ${colors.primary}50`,
            boxShadow: shadow.md,
          }}
        >
          {/* Progress */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <span
              style={{
                padding: '3px 12px',
                borderRadius: '12px',
                background: (DIMENSION_COLORS[questions[currentQ].dimension] || colors.primary) + '18',
                color: DIMENSION_COLORS[questions[currentQ].dimension] || colors.primary,
                fontFamily: fonts.sans,
                fontSize: '12px',
                fontWeight: 600,
              }}
            >
              {currentQuestion.dimension}
            </span>
            <span style={{ fontFamily: fonts.sans, fontSize: '12px', color: colors.textMuted }}>
              {currentQ + 1} / {questions.length}
            </span>
          </div>

          {/* Question text */}
          <p style={{ fontFamily: fonts.sans, fontSize: '15px', color: colors.text, lineHeight: 1.8, marginBottom: '12px', fontWeight: 500 }}>
            {displayQuestion}
          </p>

          {/* Why hint */}
          <p style={{ fontFamily: fonts.sans, fontSize: '12px', color: colors.textMuted, lineHeight: 1.6, marginBottom: '20px', fontStyle: 'italic' }}>
            💡 {currentQuestion.why}
          </p>

          {suggestedOptions.length > 0 && (
            <div
              style={{
                marginBottom: '18px',
                padding: '16px',
                borderRadius: radius.lg,
                background: 'linear-gradient(180deg, rgba(180,120,60,0.08) 0%, rgba(255,255,255,0.95) 100%)',
                border: `1px solid ${colors.primary}20`,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', marginBottom: '12px' }}>
                <div>
                  <div style={{ fontFamily: fonts.sans, fontSize: '12px', color: colors.primaryDark, fontWeight: 700, marginBottom: '4px', letterSpacing: '0.04em' }}>
                    推荐切入口
                  </div>
                </div>
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: isNarrow ? '1fr' : 'repeat(auto-fit, minmax(220px, 1fr))',
                  gap: isNarrow ? '8px' : '10px',
                }}
              >
                {suggestedOptions.map((option, index) => {
                  const animated = pressedOption === option
                  return (
                    <button
                      key={option}
                      type="button"
                      onClick={() => appendOptionToDraft(option)}
                      style={{
                        textAlign: 'left',
                        border: `1px solid ${animated ? colors.primary : colors.border}`,
                        background: animated
                          ? 'linear-gradient(135deg, rgba(180,120,60,0.16) 0%, rgba(255,255,255,1) 100%)'
                          : 'linear-gradient(135deg, rgba(255,255,255,0.98) 0%, rgba(245,240,232,0.9) 100%)',
                        color: animated ? colors.text : colors.textSecondary,
                        borderRadius: '18px',
                        padding: isNarrow ? '14px 14px' : '14px 16px',
                        fontFamily: fonts.sans,
                        fontSize: isNarrow ? '12px' : '13px',
                        lineHeight: 1.7,
                        cursor: 'pointer',
                        minHeight: isNarrow ? 'auto' : '78px',
                        boxShadow: animated ? shadow.sm : 'none',
                        transform: animated ? 'translateY(-1px) scale(0.99)' : 'translateY(0) scale(1)',
                        transition: 'all 0.18s ease',
                      }}
                    >
                      <span style={{ display: 'block' }}>{option}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Textarea */}
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="点上面的按钮自动回填到这里，再把你的具体数据、判断依据和推进动作补完整。"
            rows={6}
            style={{
              width: '100%',
              padding: isNarrow ? '12px' : '14px',
              borderRadius: radius.md,
              border: `1.5px solid ${colors.border}`,
              fontFamily: fonts.sans,
              fontSize: isNarrow ? '13px' : '14px',
              color: colors.text,
              background: colors.bg,
              resize: 'vertical',
              outline: 'none',
              lineHeight: 1.7,
              transition: 'border-color 0.2s',
            }}
            onFocus={(e) => { e.target.style.borderColor = colors.primary }}
            onBlur={(e) => { e.target.style.borderColor = colors.border }}
          />

          <div
            style={{
              display: 'flex',
              flexDirection: isNarrow ? 'column' : 'row',
              justifyContent: 'space-between',
              alignItems: isNarrow ? 'stretch' : 'center',
              gap: isNarrow ? '12px' : '16px',
              marginTop: '14px',
            }}
          >
            <span
              style={{
                fontFamily: fonts.sans,
                fontSize: '11px',
                color: colors.textMuted,
                lineHeight: 1.7,
                order: isNarrow ? 2 : 1,
              }}
            >
              点选按钮会自动回填；你也可以继续手写补充。⌘ + Enter 快速提交
            </span>
            <button
              onClick={submitAnswer}
              disabled={!canSubmit}
              style={{
                padding: isNarrow ? '13px 18px' : '10px 24px',
                borderRadius: radius.md,
                border: 'none',
                background: canSubmit ? colors.primary : colors.border,
                color: canSubmit ? '#fff' : colors.textMuted,
                fontFamily: fonts.sans,
                fontSize: isNarrow ? '15px' : '14px',
                fontWeight: 600,
                cursor: canSubmit ? 'pointer' : 'not-allowed',
                transition: 'all 0.2s ease',
                width: isNarrow ? '100%' : 'auto',
                minHeight: isNarrow ? '48px' : 'auto',
                whiteSpace: 'nowrap',
                order: isNarrow ? 1 : 2,
              }}
              onMouseEnter={(e) => { if (canSubmit) e.target.style.background = colors.primaryDark }}
              onMouseLeave={(e) => { if (canSubmit) e.target.style.background = colors.primary }}
            >
              {isLast ? '生成表达稿' : '下一题'}
            </button>
          </div>
        </div>
      )}

      <div ref={bottomRef} style={{ height: '40px' }} />
    </div>
  )
}
