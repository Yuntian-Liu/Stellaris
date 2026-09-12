/**
 * 分享卡片渲染器（V1.4.0）— 纯 Canvas 2D 手绘
 *
 * 为什么不用 html2canvas 类 DOM 截图：CSS 引擎差异 / transform / 字体加载时序
 * 都会造成错位。Canvas 手绘所有元素显式坐标布局，物理上不存在错位；
 * 文本用 measureText 逐字量宽换行，任何长度输入都不会溢出卡片。
 *
 * 设计：暖白底 / Indigo 主色 / 衬线标题 —— 与站点 Starlight 设计系统同源。
 * 内容边界（碳碳定）：只放 AI 概要（概述 + 要点），不放字幕原文（版权），
 * 不放视频源链接（会过期），底部引流本站网址。
 */

const W = 1080, H = 1440, MARGIN = 72
const CONTENT_W = W - MARGIN * 2   // 936

const COLORS = {
  canvas: '#fdfcf9',
  accent: '#4f46e5',
  accentLight: '#eef2ff',
  ink: '#171717',
  body: '#525252',
  mute: '#a3a3a3',
  hairline: '#e5e5e5',
}
const SERIF = "'Cormorant Garamond', 'Songti SC', serif"
const SANS = "'Inter', -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif"

/* ── Markdown 行内标记剥离（卡片是纯文本世界）── */
function stripMd(s) {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\$/g, '')
    .trim()
}

function truncate(s, n) {
  if (s.length <= n) return s
  return s.slice(0, n - 1).trimEnd() + '…'
}

/**
 * 概要 Markdown → 卡片结构化数据
 * 概述 = 第一个列表项/标题之前的段落；要点 = `- `/`1. ` 列表项（前 5 条，剥离标记+截断）
 * 解析不出任何内容返回 null（调用侧不弹预览）
 */
export function parseSummary(markdown, { overviewMax = 110, pointMax = 56, maxPoints = 5 } = {}) {
  if (!markdown) return null
  const overviewLines = []
  const points = []
  let inOverview = true
  for (const raw of markdown.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (/^#{1,6}\s/.test(line)) { inOverview = false; continue }
    if (/^>\s?/.test(line)) { inOverview = false; continue }
    const m = line.match(/^[-*+]\s+(.+)/) || line.match(/^\d+[.、)]\s*(.+)/)
    if (m) {
      inOverview = false
      const t = stripMd(m[1])
      if (t) points.push(t)
      continue
    }
    if (inOverview) {
      const t = stripMd(line)
      if (t) overviewLines.push(t)
    }
  }
  const overview = overviewLines.join(' ').replace(/\s+/g, ' ').trim()
  if (!overview && points.length === 0) return null
  return {
    overview: truncate(overview, overviewMax),
    points: points.slice(0, maxPoints).map((p) => truncate(p, pointMax)),
  }
}

/* ── 分词：中文逐字、西文按词（防英文单词中间断行）── */
function tokenize(text) {
  const tokens = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (/[a-zA-Z0-9]/.test(ch)) {
      let j = i
      while (j < text.length && /[a-zA-Z0-9.%+-]/.test(text[j])) j++
      tokens.push(text.slice(i, j))
      i = j
    } else {
      tokens.push(ch)
      i++
    }
  }
  return tokens
}

/** 量宽换行 + 超行省略（渲染层的第二道截断保险，parse 层已按字符截过） */
function wrapText(ctx, text, maxWidth, maxLines) {
  const lines = []
  let cur = ''
  for (const tk of tokenize(text)) {
    if (!cur && tk === ' ') continue
    const next = cur + tk
    if (cur && ctx.measureText(next).width > maxWidth) {
      lines.push(cur.trimEnd())
      cur = tk.trimStart()
    } else {
      cur = next
    }
  }
  if (cur.trim()) lines.push(cur.trimEnd())
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines)
    let last = kept[maxLines - 1]
    while (last && ctx.measureText(last + '…').width > maxWidth) last = last.slice(0, -1)
    kept[maxLines - 1] = last + '…'
    return kept
  }
  return lines
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function hairline(ctx, y) {
  ctx.strokeStyle = COLORS.hairline
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(MARGIN, y)
  ctx.lineTo(W - MARGIN, y)
  ctx.stroke()
}

/**
 * 渲染分享卡片 → canvas（调用侧 canvas.toDataURL('image/png') 自取）
 * 版式自上而下：品牌+平台胶囊 / 标题(≤2行) / 发丝线 / 概述(≤4行) / 要点(≤5条,每条≤2行) / 钉底页脚
 * 所有截断规则写死，任何输入都不会溢出 1080×1440。
 */
export async function renderShareCard({ title, platform, overview, points = [], chars }) {
  await document.fonts.ready   // 衬线字体未加载完就量宽会按 fallback 字体算，必错位
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = COLORS.canvas
  ctx.fillRect(0, 0, W, H)

  // ── 顶栏：左 = ✦ Stellaris + 定位语 ｜ 右 = 来源胶囊 + 卡片性质（左右对称，右侧不单薄）──
  const brandY = MARGIN + 30
  ctx.textBaseline = 'middle'
  ctx.fillStyle = COLORS.accent
  ctx.font = `44px ${SERIF}`
  ctx.fillText('✦', MARGIN, brandY)
  const starW = ctx.measureText('✦').width
  ctx.fillStyle = COLORS.ink
  ctx.font = `600 40px ${SERIF}`
  ctx.fillText('Stellaris', MARGIN + starW + 14, brandY)
  ctx.fillStyle = COLORS.mute
  ctx.font = `400 23px ${SANS}`
  ctx.fillText('开源 · 多平台视频字幕提取', MARGIN + 2, brandY + 46)

  if (platform) {
    ctx.font = `500 22px ${SANS}`
    const pillText = `来源：${platform}`   // 澄清来源，避免误以为与平台有关联
    const pillW = ctx.measureText(pillText).width + 36
    const pillH = 42
    const px = W - MARGIN - pillW
    const pcY = brandY + 3                  // 视觉补偿：衬线字标的光学重心偏上，胶囊微下沉
    roundRect(ctx, px, pcY - pillH / 2, pillW, pillH, pillH / 2)
    ctx.fillStyle = COLORS.accentLight
    ctx.fill()
    ctx.fillStyle = COLORS.accent
    ctx.fillText(pillText, px + 18, pcY + 1)
    // 注解对胶囊的中轴线（形状+文字组合对中轴，右对齐会因胶囊内边距永远差 18px）
    ctx.fillStyle = COLORS.mute
    ctx.font = `400 20px ${SANS}`
    ctx.textAlign = 'center'
    ctx.fillText('AI 内容概要', px + pillW / 2, brandY + 46)
    ctx.textAlign = 'left'
  }

  // ── 标题（serif 大字，≤2 行）──
  let y = brandY + 96
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = COLORS.ink
  ctx.font = `600 56px ${SERIF}`
  for (const line of wrapText(ctx, title || '未知视频', CONTENT_W, 2)) {
    y += 74
    ctx.fillText(line, MARGIN, y)
  }

  y += 30
  hairline(ctx, y)
  y += 24

  // ── 概述（≤4 行）──
  if (overview) {
    ctx.font = `400 28px ${SANS}`
    ctx.fillStyle = COLORS.body
    for (const line of wrapText(ctx, overview, CONTENT_W, 4)) {
      y += 48
      ctx.fillText(line, MARGIN, y)
    }
    y += 24
  }

  // ── 要点（圆点 + ≤5 条，每条 ≤2 行）──
  if (points.length) {
    ctx.font = `400 28px ${SANS}`
    for (const p of points) {
      ctx.fillStyle = COLORS.accent
      ctx.beginPath()
      ctx.arc(MARGIN + 6, y + 48 - 10, 5.5, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = COLORS.ink
      for (const line of wrapText(ctx, p, CONTENT_W - 34, 2)) {
        y += 48
        ctx.fillText(line, MARGIN + 34, y)
      }
      y += 18
    }
  }

  // ── 引导条（钉在页脚线上方，独立色块与正文拉开层次）：声明"节选"+完整网址 ──
  const footTextY = H - 56            // 页脚文字中线（收窄底部边距）
  const footLineY = footTextY - 30
  ctx.font = `500 23px ${SANS}`
  const ctaLines = wrapText(
    ctx,
    '本卡片仅为内容节选，完整概要、字幕与 AI 笔记请访问 https://stellaris.ytunx.com',
    CONTENT_W - 48, 2)
  const ctaH = ctaLines.length * 34 + 26
  const ctaY = footLineY - 26 - ctaH
  roundRect(ctx, MARGIN, ctaY, CONTENT_W, ctaH, 14)
  ctx.fillStyle = COLORS.accentLight
  ctx.fill()
  ctx.fillStyle = COLORS.accent
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  ctaLines.forEach((line, i) => {
    ctx.fillText(line, W / 2, ctaY + 13 + 17 + i * 34)
  })

  // ── 页脚：统计 ｜ 品牌+开源 ──
  hairline(ctx, footLineY)
  ctx.font = `400 22px ${SANS}`
  ctx.fillStyle = COLORS.mute
  ctx.textAlign = 'left'
  ctx.fillText(chars ? `共 ${chars} 字` : 'AI 概要', MARGIN, footTextY)
  ctx.textAlign = 'right'
  ctx.fillText('由 Stellaris 提取 · GitHub 开源（Yuntian-Liu/Stellaris）', W - MARGIN, footTextY)

  return canvas
}

/** 一键：渲染 + 转 dataURL（预览弹窗直接当 img src 用） */
export async function buildShareCardDataUrl(opts) {
  const canvas = await renderShareCard(opts)
  return canvas.toDataURL('image/png')
}
