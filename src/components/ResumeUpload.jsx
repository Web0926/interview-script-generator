import { useState, useRef } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import { colors, fonts, radius, shadow } from '../styles/theme.js'

// 使用 pdfjs 内置 worker
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).toString()

const ACCEPTED = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp']
const ACCEPTED_EXT = '.pdf,.png,.jpg,.jpeg,.webp'
const MAX_IMAGE_WIDTH = 1600
const MAX_IMAGE_HEIGHT = 6000
const PDF_RENDER_SCALE = 1.4
const EXPORT_QUALITY = 0.82

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result.split(',')[1])
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片读取失败'))
    image.src = src
  })
}

function normalizeCanvasSize(width, height) {
  const widthRatio = MAX_IMAGE_WIDTH / width
  const heightRatio = MAX_IMAGE_HEIGHT / height
  const ratio = Math.min(1, widthRatio, heightRatio)

  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  }
}

function exportCanvas(canvas) {
  const { width, height } = normalizeCanvasSize(canvas.width, canvas.height)
  const target = document.createElement('canvas')
  target.width = width
  target.height = height

  const ctx = target.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(canvas, 0, 0, width, height)

  const dataUrl = target.toDataURL('image/jpeg', EXPORT_QUALITY)
  return { base64: dataUrl.split(',')[1], mediaType: 'image/jpeg' }
}

async function imageFileToOptimizedBase64(file) {
  const rawBase64 = await fileToBase64(file)
  const image = await loadImage(`data:${file.type};base64,${rawBase64}`)
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  canvas.getContext('2d').drawImage(image, 0, 0)
  return exportCanvas(canvas)
}

// 把 PDF 所有页渲染成一张长图，返回 { base64, mediaType }
async function pdfToImage(file) {
  const arrayBuffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise

  const canvases = []
  let totalHeight = 0
  let maxWidth = 0

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const viewport = page.getViewport({ scale: PDF_RENDER_SCALE })
    const canvas = document.createElement('canvas')
    canvas.width = viewport.width
    canvas.height = viewport.height
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
    canvases.push(canvas)
    totalHeight += viewport.height
    maxWidth = Math.max(maxWidth, viewport.width)
  }

  // 合并所有页到一张 canvas
  const merged = document.createElement('canvas')
  merged.width = maxWidth
  merged.height = totalHeight
  const ctx = merged.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, maxWidth, totalHeight)
  let y = 0
  for (const c of canvases) {
    ctx.drawImage(c, 0, y)
    y += c.height
  }

  return exportCanvas(merged)
}

export default function ResumeUpload({ onStart }) {
  const [file, setFile] = useState(null)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')
  const [converting, setConverting] = useState(false)
  const inputRef = useRef()

  function handleFile(f) {
    if (!ACCEPTED.includes(f.type)) {
      setError('不支持该格式，请上传 PDF、PNG、JPG 或 WebP 文件')
      return
    }
    if (f.size > 20 * 1024 * 1024) {
      setError('文件大小不能超过 20MB')
      return
    }
    setError('')
    setFile(f)
  }

  function onDrop(e) {
    e.preventDefault()
    setDragging(false)
    const f = e.dataTransfer.files[0]
    if (f) handleFile(f)
  }

  async function handleStart() {
    if (!file) return
    setConverting(true)
    try {
      let base64, mediaType
      if (file.type === 'application/pdf') {
        ;({ base64, mediaType } = await pdfToImage(file))
      } else {
        ;({ base64, mediaType } = await imageFileToOptimizedBase64(file))
      }
      onStart({ base64, mediaType, fileName: file.name })
    } catch (e) {
      setError(`文件处理失败：${e.message}`)
    } finally {
      setConverting(false)
    }
  }

  const btnDisabled = !file || converting

  return (
    <div className="fade-in-up" style={{ maxWidth: '520px', margin: '0 auto', padding: '40px 24px' }}>
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
      <p style={{ fontFamily: fonts.sans, fontSize: '14px', color: colors.textMuted, marginBottom: '28px' }}>
        支持 PDF、PNG、JPG、WebP，AI 将从简历中提炼你的故事
      </p>

      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        style={{
          border: `2px dashed ${dragging ? colors.primary : file ? colors.primary : colors.border}`,
          borderRadius: radius.lg,
          padding: '48px 24px',
          textAlign: 'center',
          cursor: 'pointer',
          background: dragging ? `${colors.primary}08` : file ? `${colors.primary}05` : colors.bgSubtle,
          transition: 'all 0.2s ease',
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_EXT}
          style={{ display: 'none' }}
          onChange={(e) => { if (e.target.files[0]) handleFile(e.target.files[0]) }}
        />

        {file ? (
          <>
            <div style={{ fontSize: '32px', marginBottom: '12px' }}>📄</div>
            <p style={{ fontFamily: fonts.sans, fontSize: '15px', color: colors.text, fontWeight: 500 }}>
              {file.name}
            </p>
            <p style={{ fontFamily: fonts.sans, fontSize: '12px', color: colors.textMuted, marginTop: '4px' }}>
              {(file.size / 1024).toFixed(0)} KB · 点击更换
            </p>
          </>
        ) : (
          <>
            <div style={{ fontSize: '36px', marginBottom: '12px' }}>☁️</div>
            <p style={{ fontFamily: fonts.sans, fontSize: '15px', color: colors.textSecondary, fontWeight: 500 }}>
              拖拽文件到这里，或<span style={{ color: colors.primary }}> 点击上传</span>
            </p>
            <p style={{ fontFamily: fonts.sans, fontSize: '12px', color: colors.textMuted, marginTop: '6px' }}>
              PDF / PNG / JPG / WebP · 最大 20MB
            </p>
          </>
        )}
      </div>

      {error && (
        <p style={{ fontFamily: fonts.sans, fontSize: '13px', color: colors.error, marginTop: '10px' }}>
          {error}
        </p>
      )}

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
        onMouseEnter={(e) => { if (!btnDisabled) e.target.style.background = colors.primaryDark }}
        onMouseLeave={(e) => { if (!btnDisabled) e.target.style.background = colors.primary }}
      >
        {converting ? 'PDF 转换中…' : '开始分析简历'}
      </button>
    </div>
  )
}
