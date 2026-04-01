import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'

const ACCEPTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const MAX_PDF_BYTES = 100 * 1024 * 1024
const MAX_IMAGE_BYTES = 30 * 1024 * 1024
const MAX_PDF_PAGES = 8
const MIN_PDF_TEXT_LENGTH = 120
const MAX_TEXT_CHARS = 24000

function createCodeError(code, message = code) {
  const error = new Error(message)
  error.code = code
  return error
}

function normalizePdfText(rawText) {
  return String(rawText || '')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
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

async function parsePdfFile(file) {
  if (file.size > MAX_PDF_BYTES) {
    throw createCodeError('PDF_TOO_LARGE', 'PDF 文件不能超过 100MB')
  }

  const bytes = new Uint8Array(await file.arrayBuffer())

  let pdf
  try {
    pdf = await pdfjsLib.getDocument({ data: bytes }).promise
  } catch (error) {
    if (String(error?.message || '').toLowerCase().includes('password')) {
      throw createCodeError('PDF_PASSWORD_PROTECTED', '暂不支持带密码的 PDF，请去掉密码后重试')
    }
    throw createCodeError('INVALID_PDF', 'PDF 文件无法解析，请重新导出后重试')
  }

  if (pdf.numPages > MAX_PDF_PAGES) {
    throw createCodeError('PDF_PAGE_LIMIT_EXCEEDED', `简历页数不能超过 ${MAX_PDF_PAGES} 页，请上传更精简的简历版本`)
  }

  const pageTexts = []

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber)
    const content = await page.getTextContent()
    const pageText = extractTextFromTextContent(content)
    if (pageText) {
      pageTexts.push(`第 ${pageNumber} 页\n${pageText}`)
    }
  }

  const normalizedText = normalizePdfText(pageTexts.join('\n\n'))
  if (normalizedText.length < MIN_PDF_TEXT_LENGTH) {
    throw createCodeError('SCAN_PDF_NEEDS_IMAGE', '当前 PDF 更像扫描件，暂时请先转成图片上传，或导出为可复制文字的 PDF')
  }

  const truncated = truncateResumeText(normalizedText)

  return {
    kind: 'text',
    source: 'pdf_text',
    text: truncated.text,
    truncated: truncated.truncated,
    originalTextLength: truncated.originalTextLength,
    fileName: file.name || '',
    pageCount: pdf.numPages,
  }
}

async function parseImageFile(file) {
  if (file.size > MAX_IMAGE_BYTES) {
    throw createCodeError('IMAGE_TOO_LARGE', '图片简历不能超过 30MB，请压缩后重试')
  }

  if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
    throw createCodeError('UNSUPPORTED_FILE_TYPE', '不支持该格式，请上传 PDF、PNG、JPG 或 WebP 文件')
  }

  const bytes = Buffer.from(await file.arrayBuffer())

  return {
    kind: 'images',
    source: 'image',
    fileName: file.name || '',
    pageCount: 1,
    pages: [
      {
        base64: bytes.toString('base64'),
        mediaType: file.type,
      },
    ],
  }
}

export async function parseResumeFile(file) {
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw createCodeError('RESUME_CONTENT_EMPTY', '没有接收到简历文件，请重新上传')
  }

  if (file.type === 'application/pdf') {
    return parsePdfFile(file)
  }

  return parseImageFile(file)
}
