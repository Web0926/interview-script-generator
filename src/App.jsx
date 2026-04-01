import { useEffect, useState } from 'react'
import { colors, fonts, shadow } from './styles/theme.js'
import ProgressBar from './components/ProgressBar.jsx'
import RedeemGate from './components/RedeemGate.jsx'
import ResumeUpload from './components/ResumeUpload.jsx'
import QASession from './components/QASession.jsx'
import ScriptResult from './components/ScriptResult.jsx'
import LoadingState from './components/LoadingState.jsx'
import {
  analyzeResume,
  clearStoredSessionToken,
  generateScripts,
  getOrCreateClientId,
  getStoredSessionToken,
  redeemOrder,
  restoreSession,
  storeSessionToken,
} from './services/appApi.js'

const INITIAL_STATE = {
  step: 'restoring',
  clientId: null,
  sessionToken: null,
  analysisResult: null,
  analysisMeta: null,
  scripts: null,
  error: null,
}

function buildAnalysisMeta(resumeInput) {
  if (!resumeInput || typeof resumeInput !== 'object') {
    return null
  }

  return {
    kind: resumeInput.kind,
    source: resumeInput.source,
    pageCount: Number(resumeInput.pageCount || 0),
    truncated: Boolean(resumeInput.truncated),
  }
}

function getAnalyzingSubmessage(analysisMeta) {
  if (!analysisMeta) {
    return '正在梳理最值得展开的经历，以及你可以讲清楚的问题、判断和结果'
  }

  if (analysisMeta.source === 'pdf_text') {
    return analysisMeta.truncated
      ? '已识别为文字版 PDF，正在直接分析提取出的关键信息；内容过长时会自动截取前面的重点部分，以保证稳定性。'
      : '已识别为文字版 PDF，正在直接分析提取出的简历文本，这通常比整份转图片更稳也更快。'
  }

  if (analysisMeta.source === 'pdf_images') {
    return `检测到扫描版 PDF，正在分析压缩后的前 ${analysisMeta.pageCount || 0} 页内容；扫描件会比文字版稍慢一些。`
  }

  if (analysisMeta.source === 'image') {
    return '正在分析压缩后的图片版简历内容，并提炼最适合展开的经历。'
  }

  return '正在梳理最值得展开的经历，以及你可以讲清楚的问题、判断和结果'
}

export default function App() {
  const [state, setState] = useState(INITIAL_STATE)

  useEffect(() => {
    const clientId = getOrCreateClientId()
    const sessionToken = getStoredSessionToken()

    if (!sessionToken) {
      setState((s) => ({
        ...s,
        clientId,
        sessionToken: null,
        step: 'redeem',
      }))
      return
    }

    let cancelled = false

    async function boot() {
      try {
        const result = await restoreSession({ sessionToken, clientId })
        if (cancelled) return

        setState((s) => ({
          ...s,
          clientId,
          sessionToken,
          analysisResult: result.session.analysisResult,
          analysisMeta: null,
          scripts: result.session.scriptsResult,
          step: result.session.currentStep || 'upload',
          error: result.session.lastError,
        }))
      } catch {
        clearStoredSessionToken()
        if (cancelled) return

        setState((s) => ({
          ...s,
          clientId,
          sessionToken: null,
          analysisResult: null,
          analysisMeta: null,
          scripts: null,
          error: null,
          step: 'redeem',
        }))
      }
    }

    boot()

    return () => {
      cancelled = true
    }
  }, [])

  async function handleRedeem({ orderNo, phoneLast4 }) {
    const result = await redeemOrder({
      orderNo,
      phoneLast4,
      clientId: state.clientId,
    })

    storeSessionToken(result.sessionToken)

    setState((s) => ({
      ...s,
      sessionToken: result.sessionToken,
      analysisResult: result.session.analysisResult,
      analysisMeta: null,
      scripts: result.session.scriptsResult,
      error: null,
      step: result.session.currentStep || 'upload',
    }))
  }

  // Step 1 → 2: Upload resume and start analysis
  async function handleUploadStart({ resumeInput }) {
    setState((s) => ({
      ...s,
      step: 'analyzing',
      error: null,
      analysisMeta: buildAnalysisMeta(resumeInput),
    }))
    try {
      const result = await analyzeResume({
        sessionToken: state.sessionToken,
        clientId: state.clientId,
        resumeInput,
      })
      setState((s) => ({ ...s, analysisResult: result.analysisResult, step: 'qa' }))
    } catch (e) {
      setState((s) => ({ ...s, step: 'upload', error: `简历分析失败：${e.message}` }))
    }
  }

  // Step 3 → 4: All answers submitted, generate scripts
  async function handleQAComplete(answers) {
    setState((s) => ({ ...s, step: 'generating', error: null }))
    try {
      const result = await generateScripts({
        sessionToken: state.sessionToken,
        clientId: state.clientId,
        answers,
      })
      setState((s) => ({ ...s, scripts: result.scripts, step: 'result' }))
    } catch (e) {
      setState((s) => ({ ...s, step: 'qa', error: `逐字稿生成失败：${e.message}` }))
    }
  }

  function handleRestart() {
    clearStoredSessionToken()
    setState((s) => ({
      ...INITIAL_STATE,
      clientId: s.clientId,
      step: 'redeem',
    }))
  }

  const { step, analysisResult, scripts, error } = state
  const analyzingSubmessage = getAnalyzingSubmessage(state.analysisMeta)

  return (
    <div style={{ minHeight: '100vh', background: colors.bg }}>
      {/* Header */}
      <header
        style={{
          background: 'linear-gradient(135deg, #2c1a0e 0%, #4a2c10 60%, #6b3d18 100%)',
          padding: '28px 24px 24px',
          boxShadow: shadow.md,
        }}
      >
        <div style={{ maxWidth: '760px', margin: '0 auto' }}>
          <h1
            style={{
              fontFamily: fonts.serif,
              fontSize: '22px',
              fontWeight: 700,
              color: '#faf0e0',
              marginBottom: '4px',
              letterSpacing: '0.02em',
            }}
          >
            面试逐字稿生成器
          </h1>
          <p style={{ fontFamily: fonts.sans, fontSize: '13px', color: '#c4a882' }}>
            把散装经历整理成更稳、更清楚的面试表达
          </p>
        </div>
      </header>

      {/* Progress Bar */}
      {!['restoring', 'redeem'].includes(step) && <ProgressBar step={step} />}

      {/* Error banner */}
      {error && (
        <div
          style={{
            maxWidth: '680px',
            margin: '20px auto 0',
            padding: '12px 16px',
            borderRadius: '8px',
            background: '#fdf0ee',
            border: '1px solid #f0c4bd',
            color: colors.error,
            fontFamily: fonts.sans,
            fontSize: '13px',
            display: 'flex',
            gap: '8px',
            alignItems: 'flex-start',
          }}
        >
          <span>⚠️</span>
          <span>{error}</span>
        </div>
      )}

      {/* Main content */}
      <main>
        {step === 'restoring' && (
          <LoadingState
            message="正在恢复你的使用会话…"
            submessage="如果你之前已经兑换过，我们会自动把你带回上次的进度"
          />
        )}
        {step === 'redeem' && (
          <RedeemGate onRedeem={handleRedeem} />
        )}
        {step === 'upload' && (
          <ResumeUpload onStart={handleUploadStart} />
        )}
        {step === 'analyzing' && (
          <LoadingState
            message="AI 正在分析你的简历…"
            submessage={analyzingSubmessage}
          />
        )}
        {step === 'qa' && analysisResult && (
          <QASession analysisResult={analysisResult} onComplete={handleQAComplete} />
        )}
        {step === 'generating' && (
          <LoadingState
            message="正在生成你的表达稿…"
            submessage="AI 正在把你的经历整理成更自然、克制、可信的面试表达，大约需要 20-30 秒"
          />
        )}
        {step === 'result' && scripts && (
          <ScriptResult scripts={scripts} onRestart={handleRestart} restartLabel="兑换新的订单" />
        )}
      </main>
    </div>
  )
}
