import { useRef, useState } from 'react'
import { colors, fonts, radius, shadow } from '../styles/theme.js'

const ACCEPTED = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp']
const ACCEPTED_EXT = '.pdf,.png,.jpg,.jpeg,.webp'
const MAX_PDF_BYTES = 100 * 1024 * 1024
const MAX_IMAGE_BYTES = 30 * 1024 * 1024

function getReadableUploadHint(file) {
  if (!file) {
    return '点击开始后会直接上传原文件到服务器解析，避免浏览器先卡在本地处理 PDF。'
  }

  if (file.type === 'application/pdf') {
    return '点击开始后会直接上传 PDF，并在服务器提取文本；扫描版 PDF 如识别不到文字，会提示你改传图片或文字版 PDF。'
  }

  return '点击开始后会直接上传图片简历，并由服务器完成后续分析。'
}

function getFileValidationError(file) {
  if (!ACCEPTED.includes(file.type)) {
    return '不支持该格式，请上传 PDF、PNG、JPG 或 WebP 文件'
  }

  if (file.type === 'application/pdf' && file.size > MAX_PDF_BYTES) {
    return 'PDF 文件不能超过 100MB'
  }

  if (file.type !== 'application/pdf' && file.size > MAX_IMAGE_BYTES) {
    return '图片简历不能超过 30MB，请压缩后重试'
  }

  return ''
}

export default function ResumeUpload({ onStart }) {
  const [file, setFile] = useState(null)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef()

  function handleFile(nextFile) {
    const nextError = getFileValidationError(nextFile)
    if (nextError) {
      setError(nextError)
      return
    }

    setError('')
    setFile(nextFile)
  }

  function onDrop(event) {
    event.preventDefault()
    setDragging(false)
    const droppedFile = event.dataTransfer.files[0]
    if (droppedFile) {
      handleFile(droppedFile)
    }
  }

  async function handleStart() {
    if (!file || submitting) return

    setSubmitting(true)
    try {
      await onStart({ file })
    } catch (startError) {
      setError(`文件上传失败：${startError.message}`)
      setSubmitting(false)
    }
  }

  const btnDisabled = !file || submitting

  return (
    <div className="fade-in-up" style={{ maxWidth: '560px', margin: '0 auto', padding: '40px 24px' }}>
      <h2
        style={{
          fontFamily: fonts.serif,
          fontSize: '22px',
          color: colors.text,
          marginBottom: '8px',
          fontWeight: 600,
        }}
      >
        上传你的简历
      </h2>
      <p style={{ fontFamily: fonts.sans, fontSize: '14px', color: colors.textMuted, marginBottom: '8px' }}>
        支持 PDF、PNG、JPG、WebP，AI 将从简历中提炼你的故事
      </p>
      <p style={{ fontFamily: fonts.sans, fontSize: '12px', color: colors.textMuted, lineHeight: 1.7, marginBottom: '28px' }}>
        文字版 PDF 最多 100MB，图片简历最多 30MB。系统会优先在服务器解析 PDF 文本，减少浏览器卡顿。
      </p>

      <div
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => {
          if (!submitting) {
            inputRef.current?.click()
          }
        }}
        style={{
          border: `2px dashed ${dragging ? colors.primary : file ? colors.primary : colors.border}`,
          borderRadius: radius.lg,
          padding: '48px 24px',
          textAlign: 'center',
          cursor: submitting ? 'wait' : 'pointer',
          background: dragging ? `${colors.primary}08` : file ? `${colors.primary}05` : colors.bgSubtle,
          transition: 'all 0.2s ease',
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_EXT}
          style={{ display: 'none' }}
          onChange={(event) => {
            if (event.target.files[0]) {
              handleFile(event.target.files[0])
            }
          }}
        />

        {file ? (
          <>
            <div style={{ fontSize: '32px', marginBottom: '12px' }}>📄</div>
            <p style={{ fontFamily: fonts.sans, fontSize: '15px', color: colors.text, fontWeight: 500 }}>
              {file.name}
            </p>
            <p style={{ fontFamily: fonts.sans, fontSize: '12px', color: colors.textMuted, marginTop: '4px' }}>
              {(file.size / 1024 / 1024).toFixed(2)} MB · 点击更换
            </p>
          </>
        ) : (
          <>
            <div style={{ fontSize: '36px', marginBottom: '12px' }}>☁️</div>
            <p style={{ fontFamily: fonts.sans, fontSize: '15px', color: colors.textSecondary, fontWeight: 500 }}>
              拖拽文件到这里，或<span style={{ color: colors.primary }}> 点击上传</span>
            </p>
            <p style={{ fontFamily: fonts.sans, fontSize: '12px', color: colors.textMuted, marginTop: '6px' }}>
              PDF 最多 100MB · 图片最多 30MB
            </p>
          </>
        )}
      </div>

      {error && (
        <p style={{ fontFamily: fonts.sans, fontSize: '13px', color: colors.error, marginTop: '10px' }}>
          {error}
        </p>
      )}

      <p style={{ fontFamily: fonts.sans, fontSize: '12px', color: colors.textMuted, marginTop: '10px', lineHeight: 1.7 }}>
        {getReadableUploadHint(file)}
      </p>

      <button
        onClick={handleStart}
        disabled={btnDisabled}
        style={{
          marginTop: '24px',
          width: '100%',
          padding: '14px',
          borderRadius: radius.md,
          border: 'none',
          background: btnDisabled ? colors.border : colors.primary,
          color: btnDisabled ? colors.textMuted : '#fff',
          fontFamily: fonts.sans,
          fontSize: '15px',
          fontWeight: 600,
          cursor: btnDisabled ? 'not-allowed' : 'pointer',
          transition: 'all 0.2s ease',
          boxShadow: btnDisabled ? 'none' : shadow.sm,
        }}
        onMouseEnter={(event) => {
          if (!btnDisabled) {
            event.target.style.background = colors.primaryDark
          }
        }}
        onMouseLeave={(event) => {
          if (!btnDisabled) {
            event.target.style.background = colors.primary
          }
        }}
      >
        {submitting ? '上传中…' : '开始分析简历'}
      </button>
    </div>
  )
}
