/**
 * 剪贴板视频链接检测（V1.2.0 剪贴板自动检测 + 预估弹窗）
 *
 * 三通道触发（focus / click / paste）+ 能力探测分流，检测到新的支持平台视频链接
 * → 交给 HomePage 弹窗。设计定稿：tmp/collab/clipboard-autofill/05_kimi.md + 07_kimi.md
 *
 * 节制原则（碳碳红线）：
 *   - 多重闸门全过才读剪贴板（hook 内：弹窗已开/冷却/能力探测/焦点位置；
 *     调用方 canTrigger 透传：输入框为空 + 非 busy）；任何异常一律静默退出
 *   - 「已见过名单」记 localStorage：提取过/拒绝过/探测失败的链接都不再弹
 *   - Safari/Firefox/隐身模式等读不了的环境 → 整体静默降级
 */
import { useEffect, useRef, useState } from 'react'

const SEEN_KEY = 'stellaris_clip_seen'
const SEEN_MAX = 50
const COOLDOWN_MS = 10_000        // 全局冷却：两次检测最小间隔
const MAX_TEXT = 10 * 1024        // 剪贴板文本截断（防几 MB 垃圾文本拖慢正则）

// 支持平台的链接（混在文字里也能抽出；排除中英文右括号/引号等常见包裹字符）
const LINK_RE = /https?:\/\/[^\s<>"'()（）【】]*?(?:bilibili\.com|b23\.tv|xiaohongshu\.com|xhslink\.com)[^\s<>"'()（）【】]*/i
// BV 裸号（B站 App 偶见只复制 BV 号）
const BV_RE = /\bBV[0-9A-Za-z]{10}\b/

/** 从剪贴板文本抽取第一个支持平台的链接（含 BV 裸号补全） */
function extractLink(text) {
  const m = text.slice(0, MAX_TEXT).match(LINK_RE)
  if (m) return m[0]
  const bv = text.slice(0, MAX_TEXT).match(BV_RE)
  if (bv) return `https://www.bilibili.com/video/${bv[0]}`
  return null
}

/**
 * URL 归一化（名单比对键；剥追踪参数但保留内容参数）：
 * 剥零宽字符 → trim → HTML 实体 &amp; → 协议统一 https → host 小写 →
 * query 白名单只留 p/t（分P/时间点属内容差异）→ 剥 fragment → 剥末尾 /
 */
export function normalizeClipUrl(raw) {
  let u = (raw || '').replace(/[\u200B\u200C\u200D\uFEFF]/g, '').trim().replace(/&amp;/g, '&')
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u
  try {
    const url = new URL(u)
    url.protocol = 'https:'
    url.hash = ''
    url.pathname = url.pathname.replace(/\/+$/, '')   // 末尾斜杠在 query 之前也要剥
    const keep = new URLSearchParams()
    for (const k of ['p', 't']) {
      const v = url.searchParams.get(k)
      if (v !== null) keep.set(k, v)
    }
    url.search = keep.toString()
    return url.toString().replace(/\/$/, '')
  } catch {
    return u
  }
}

/** 读名单；localStorage 不可用（隐身模式等）返回 null = 整体静默降级 */
function readSeen() {
  try {
    const arr = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')
    return Array.isArray(arr) ? arr : []
  } catch {
    return null
  }
}

/** 记入名单（FIFO，上限 SEEN_MAX）。供 HomePage 在用户表态后调用 */
export function markClipSeen(normalized) {
  const seen = readSeen()
  if (!seen) return
  seen.push(normalized)
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen.slice(-SEEN_MAX)))
  } catch { /* 写失败静默 */ }
}

/**
 * @param canTrigger 调用方闸门（HomePage：输入框为空且非 busy）
 * @returns { candidate, resolveCandidate }
 *   candidate: { url, normalized } | null（非 null 即应弹窗）
 *   resolveCandidate(): 用户表态后调用——记名单 + 关闭，允许下次检测
 */
export default function useClipboardLink(canTrigger) {
  const [candidate, setCandidate] = useState(null)
  const openRef = useRef(false)        // 弹窗开着 → 不再触发（防双弹）
  const lastCheckRef = useRef(0)
  const canTriggerRef = useRef(canTrigger)
  canTriggerRef.current = canTrigger   // 最新闸门透传，避免重复订阅 focus

  useEffect(() => {
    // 程序化读剪贴板的能力探测（一次性）：
    // Chrome/Edge 支持 permissions.query('clipboard-read') → 允许 focus/click 触发 readText；
    // Safari 不认识这个权限名（query 抛错）→ 判定不可读，**彻底不碰 readText**——
    // 否则 Safari 每次 click 都弹系统"粘贴"确认气泡，吞掉用户的第一次点击（碳碳实测踩坑）。
    let readAllowed = null   // null=未探测
    const probeReadAllowed = async () => {
      if (readAllowed !== null) return readAllowed
      let ok = false
      try {
        if (navigator.clipboard?.readText && navigator.permissions?.query) {
          const st = await navigator.permissions.query({ name: 'clipboard-read' })
          ok = st.state !== 'denied'
        }
      } catch { ok = false }
      readAllowed = ok
      return ok
    }

    /** 文本过闸 → 命中则弹窗（抽取/归一化/名单去重） */
    const inspect = (text) => {
      if (openRef.current) return      // 二次校验：堵 await 之后的竞态窗口（小克 09 棒建议）
      if (!text) return
      const link = extractLink(text)
      if (!link) return
      const normalized = normalizeClipUrl(link)
      const seen = readSeen()
      if (!seen) return                // localStorage 不可用 → 静默降级
      if (seen.includes(normalized)) return
      lastCheckRef.current = Date.now()   // 冷却只在"真的弹了"时启动（读剪贴板无害，不值得限）
      openRef.current = true
      setCandidate({ url: link, normalized })
    }

    /** 公共闸门：弹窗已开 / 冷却 / 调用方条件（只读不改冷却时间戳） */
    const gatesPass = () => {
      if (openRef.current) return false
      if (Date.now() - lastCheckRef.current < COOLDOWN_MS) return false
      return canTriggerRef.current()
    }

    // focus 触发：仅能力允许的浏览器（Edge 实测可自动读）；Safari 已被探测挡在门外
    const onFocus = async () => {
      if (!gatesPass()) return
      if (!(await probeReadAllowed())) return
      // 切回时焦点可能仍停在有内容的输入控件里（如 sessdata 填到一半），不打扰（Minimax 08 棒 D1）
      const ae = document.activeElement
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)
          && (ae.value || ae.textContent || '').trim()) return
      try {
        inspect(await navigator.clipboard.readText())
      } catch { /* 权限被拒 → 静默 */ }
    }

    // click 触发：真实用户手势 + 能力允许才读（Chrome/Edge 放行，无气泡）
    const onClick = async () => {
      if (!gatesPass()) return
      if (!(await probeReadAllowed())) return
      // 点击时若焦点停在仍有内容的输入控件里（如 sessdata 填到一半），不打扰
      const ae = document.activeElement
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)
          && (ae.value || ae.textContent || '').trim()) return
      try {
        inspect(await navigator.clipboard.readText())
      } catch { /* 静默 */ }
    }

    // paste 触发：粘贴事件自带剪贴板文本，零权限零气泡，Safari 的主通道。
    // 目标是输入控件 → 原生粘贴流程，不拦；粘贴到页面空白 → 直接弹窗
    const onPaste = (e) => {
      const t = e.target
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (!gatesPass()) return
      inspect(e.clipboardData?.getData('text') || '')
    }

    window.addEventListener('focus', onFocus)
    window.addEventListener('click', onClick)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('click', onClick)
      window.removeEventListener('paste', onPaste)
    }
  }, [])

  const resolveCandidate = () => {
    if (candidate) markClipSeen(candidate.normalized)
    openRef.current = false
    setCandidate(null)
  }

  return { candidate, resolveCandidate }
}
