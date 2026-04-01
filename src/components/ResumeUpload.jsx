import { useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import { colors, fonts, radius, shadow } from '../styles/theme.js'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).toString()

const ACCEPTED = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp']
const ACCEPTED_EXT = '.pdf,.png,.jpg,.jpeg,.webp'
const MAX_PDF_BYTES = 100 * 1024 * 1024
const MAX_IMAGE_BYTES = 30 * 1024 * 1024
const MAX_PDF_PAGES = 8
const MAX_IMAGE_PAGE_COUNT = 3
const MIN_PDF_TEXT_LENGTH = 120
const MAX_TEXT_CHARS = 24000
const MAX_IMAGE_WIDTH = 1400
const MAX_IMAGE_HEIGHT = 2200
const PDF_RENDER_SCALE = 1.15
const EXPORT_QUALITY_STEPS = [0.82, 0.74, 0.66, 0.58, 0.5]
const TARGET_PAGE_BYTES = 220 * 1024
const MAX_PAGE_BYTES = 320 * 1024
const RESIZE_REDUCTION_FACTOR = 0.85
const MIN_RESIZE_RATIO = 0.55

function estimatePayloadBytes(base64) {
  return base64.length
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

function renderCanvasToBase64(canvas, { width, height, quality }) {
  const target = document.createElement('canvas')
  target.width = width
  target.height = height

  const ctx = target.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(canvas, 0, 0, width, height)

  const dataUrl = target.toDataURL('image/jpeg', quality)
  const base64 = dataUrl.split(',')[1]

  return {
    base64,
    mediaType: 'image/jpeg',
    bytes: estimatePayloadBytes(base64),
  }
}

function exportCanvas(canvas) {
  const normalizedSize = normalizeCanvasSize(canvas.width, canvas.height)
  const minWidth = Math.min(
    normalizedSize.width,
    Math.max(900, Math.round(normalizedSize.width * MIN_RESIZE_RATIO))
  )
  const minHeight = Math.min(
    normalizedSize.height,
    Math.max(1200, Math.round(normalizedSize.height * MIN_RESIZE_RATIO))
  )

  let currentSize = normalizedSize
  let bestResult = null

  while (true) {
    for (const quality of EXPORT_QUALITY_STEPS) {
      const result = renderCanvasToBase64(canvas, {
        width: currentSize.width,
        height: currentSize.height,
        quality,
      })

      if (!bestResult || result.bytes < bestResult.bytes) {
        bestResult = result
      }

      if (result.bytes <= TARGET_PAGE_BYTES) {
        return { base64: result.base64, mediaType: result.mediaType }
      }
    }

    if (bestResult && bestResult.bytes <= MAX_PAGE_BYTES) {
      return { base64: bestResult.base64, mediaType: bestResult.mediaType }
    }

    const nextSize = {
      width: Math.max(minWidth, Math.round(currentSize.width * RESIZE_REDUCTION_FACTOR)),
      height: Math.max(minHeight, Math.round(currentSize.height * RESIZE_REDUCTION_FACTOR)),
    }

    if (nextSize.width === currentSize.width && nextSize.height === currentSize.height) {
      break
    }

    currentSize = nextSize
  }

  throw new Error('扫描版简历页面过大，请导出更清晰但更精简的 PDF 后重试')
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片读取失败'))
    image.src = src
  })
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result.split(',')[1])
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function normalizePdfText(rawText) {
  return String(rawText || '')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function truncateResumeText(text) {
  const normalized = String(text || '').trim()
  if (normalized.length <= MAX_TEXT_CHARS) {
    return {
      text: normalized,
      truncated: false,
      originalTextLength: normalized.length,
    }
  }

  return {
    text: normalized.slice(0, MAX_TEXT_CHARS).trimEnd(),
    truncated: true,
    originalTextLength: normalized.length,
  }
}

function extractTextFromTextContent(content) {
  const lines = []
  let current = ''

  for (const item of content.items) {
    const chunk = String(item.str || '').trim()
    if (chunk) {
      current = current ? `${current} ${chunk}` : chunk
    }

    if (item.hasEOL && current) {
      lines.push(current)
      current = ''
    }
  }

  if (current) {
    lines.push(current)
  }

  return lines.join('\n')
}

async function buildPdfTextResumeInput(pdf, fileName) {
  const pages = []

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber)
    const content = await page.getTextContent()
    const pageText = extractTextFromTextContent(content)
    if (pageText) {
      pages.push(`第 ${pageNumber} 页\n${pageText}`)
    }
  }

  const text = normalizePdfText(pages.join('\n\n'))
  if (text.length < MIN_PDF_TEXT_LENGTH) {
    return null
  }

  const truncated = truncateResumeText(text)

  return {
    kind: 'text',
    source: 'pdf_text',
    text: truncated.text,
    truncated: truncated.truncated,
    originalTextLength: truncated.originalTextLength,
    fileName,
    pageCount: pdf.numPages,
  }
}

async function buildPdfImageResumeInput(pdf, fileName) {
  if (pdf.numPages > MAX_IMAGE_PAGE_COUNT) {
    throw new Error(`扫描版 PDF 最多支持 ${MAX_IMAGE_PAGE_COUNT} 页，请上传前 ${MAX_IMAGE_PAGE_COUNT} 页或导出文字版 PDF`)
  }

  const pages = []

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber)
    const viewport = page.getViewport({ scale: PDF_RENDER_SCALE })
    const canvas = document.createElement('canvas')
    canvas.width = viewport.width
    canvas.height = viewport.height

    await page.render({
      canvasContext: canvas.getContext('2d'),
      viewport,
    }).promise

    pages.push(exportCanvas(canvas))
  }

  return {
    kind: 'images',
    source: 'pdf_images',
    pages,
    fileName,
    pageCount: pdf.numPages,
  }
}

async function pdfFileToResumeInput(file) {
  if (file.size > MAX_PDF_BYTES) {
    throw new Error('PDF 文件不能超过 100MB')
  }

  const arrayBuffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise

  if (pdf.numPages > MAX_PDF_PAGES) {
    throw new Error(`简历页数不能超过 ${MAX_PDF_PAGES} 页，请上传更精简的简历版本`)
  }

  const textResumeInput = await buildPdfTextResumeInput(pdf, file.name)
  if (textResumeInput) {
    return textResumeInput
  }

  return buildPdfImageResumeInput(pdf, file.name)
}

async function imageFileToResumeInput(file) {
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error('图片简历不能超过 30MB，请压缩后重试')
  }

  const rawBase64 = await fileToBase64(file)
  const image = await loadImage(`data:${file.type};base64,${rawBase64}`)
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  canvas.getContext('2d').drawImage(image, 0, 0)

  return {
    kind: 'images',
    source: 'image',
    pages: [exportCanvas(canvas)],
    fileName: file.name,
    pageCount: 1,
  }
}

function getReadableProcessingError(error) {
  const message = String(error?.message || '')

  if (message.includes('password')) {
    return '暂不支持带密码的 PDF，请去掉密码后重试'
  }

  if (message.includes('Invalid PDF')) {
    return 'PDF 文件无法解析，请重新导出后重试'
  }

  return message || '文件处理失败，请重试'
}

function getSelectedFileHint(file) {
  if (!file) {
    return '文字版 PDF 会直接提取文本，扫描版只会压缩前 3 页，尽量把网络传输控制在更稳的范围内。'
  }

  if (file.type === 'application/pdf') {
    return '我们会先尝试直接提取 PDF 文本；只有检测到扫描版时，才会压缩前 3 页图片上传。'
  }

  return '图片简历会先自动压缩后再上传，减少网络波动导致的失败。'
}

export default function ResumeUpload({ onStart }) {
  const [file, setFile] = useState(null)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')
  const [converting, setConverting] = useState(false)
  const inputRef = useRef()

  function handleFile(nextFile) {
    if (!ACCEPTED.includes(nextFile.type)) {
      setError('不支持该格式，请上传 PDF、PNG、JPG 或 WebP 文件')
      return
    }

    if (nextFile.type === 'application/pdf' && nextFile.size > MAX_PDF_BYTES) {
      setError('PDF 文件不能超过 100MB')
      return
    }

    if (nextFile.type !== 'application/pdf' && nextFile.size > MAX_IMAGE_BYTES) {
      setError('图片简历不能超过 30MB，请压缩后重试')
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
    if (!file) return

    setConverting(true)
    try {
      const resumeInput = file.type === 'application/pdf'
        ? await pdfFileToResumeInput(file)
        : await imageFileToResumeInput(file)

      onStart({ resumeInput })
    } catch (processingError) {
      setError(`文件处理失败：${getReadableProcessingError(processingError)}`)
    } finally {
      setConverting(false)
    }
  }

  const btnDisabled = !file || converting

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
        文字版 PDF 最多 100MB，会优先直接提取文本；扫描版 PDF 会自动压缩前 3 页；图片简历最多 30MB。
      </p>

      <div
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
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
        {getSelectedFileHint(file)}
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
        {converting ? '简历处理中…' : '开始分析简历'}
      </button>
    </div>
  )
}
