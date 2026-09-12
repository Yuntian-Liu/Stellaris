/**
 * SRT 解析与「分段段落 → 时间码」映射（字幕时间戳回跳用）
 * 数据关系：预览文本 = LLM 智能分段（只插段落符），SRT cue 与段落同源，
 * 因此用「归一化包含匹配」为每段找回其起始 cue 的秒数；匹配失败静默降级（null）
 */

/** 解析标准 SRT 文本 → [{ sec, text }]（text 为多行拼接） */
export function parseSrt(srt) {
  const cues = []
  if (!srt) return cues
  const blocks = String(srt).replace(/\r/g, '').split(/\n\s*\n/)
  for (const block of blocks) {
    const lines = block.trim().split('\n').filter(Boolean)
    if (!lines.length) continue
    // 首行可能是序号；找到时间轴行
    const ti = lines.findIndex((l) => l.includes('-->'))
    if (ti === -1) continue
    const m = lines[ti].match(/(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->/)
    if (!m) continue
    const sec = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3])
    cues.push({ sec, text: lines.slice(ti + 1).join('') })
  }
  return cues
}

/** 归一化：去全部空白与中英文标点（匹配用，只保留"字"） */
export function normalize(s) {
  return String(s || '')
    .replace(/\s+/g, '')
    .replace(/[，。！？、；：""''（）《》〈〉【】…—·～,.!?;:"'()\[\]<>~\-]/g, '')
}

/**
 * 段落 → 起始秒数映射（游标式顺序匹配，游标不回退保证时间单调）
 * previewText 按换行切段；每段取归一化文本，从游标起找首个被段落包含的 cue
 * 返回 [{ text, sec|null }]（匹配失败的段为 null，不显示时间码）
 */
export function mapParagraphTimes(previewText, srtText) {
  // 分段文本以换行分段（实测为单 \n；\n+ 兼容空行形态，空白段过滤）
  const paragraphs = String(previewText || '').split(/\n+/).filter((p) => p.trim())
  const cues = parseSrt(srtText).map((c) => ({ sec: c.sec, norm: normalize(c.text) }))
  let cursor = 0
  return paragraphs.map((text) => {
    const paraNorm = normalize(text)
    let sec = null
    if (paraNorm) {
      for (let i = cursor; i < cues.length; i++) {
        const probe = cues[i].norm.slice(0, 10)
        if (probe.length >= 4 && paraNorm.includes(probe)) {
          sec = cues[i].sec
          cursor = i + 1
          break
        }
      }
    }
    return { text, sec }
  })
}
