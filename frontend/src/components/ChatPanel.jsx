/**
 * AI 解读对话面板 — 结果页右栏
 *
 * 交互：
 *   - 首开显示建议问题 chips，点击即发送
 *   - SSE 流式：AI 气泡逐段出现；等待首包时三点弹跳
 *   - 每条 AI 气泡底部显示本轮 token 用量（含缓存命中比例）
 *   - 「导出对话」前端拼 MD 直接下载（不走后端）
 *
 * 对话记录只存本组件 state，刷新即清空；后端无状态，字幕全文由后端注入。
 */
import { useState, useRef, useEffect } from 'react'
import { Button, Input } from 'antd'
import {
  SendOutlined, DownloadOutlined, CloseOutlined,
  InfoCircleOutlined, ThunderboltOutlined,
} from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import api from '../hooks/api'
import { MD_COMPONENTS } from '../pages/ResultPage'

const SUGGESTIONS = [
  '这个视频讲了什么？',
  '帮我整理成学习笔记',
  '这个视频对我有什么启发？',
]

/** 千分位缩写：12345 → 12.3k */
function fmtTokens(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/** 前端拼对话记录为 Markdown 并触发下载 */
function downloadChatMd(videoTitle, messages) {
  const lines = [
    `# 《${videoTitle}》AI 解读记录`,
    '',
    `> 由 Stellaris 生成 · ${new Date().toLocaleString('zh-CN')}`,
    '',
  ]
  for (const m of messages) {
    lines.push(m.role === 'user' ? `## 🙋 提问` : `## ✦ AI 解读`)
    lines.push('')
    lines.push(m.content)
    lines.push('')
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `stellaris-chat-${Date.now()}.md`
  a.click()
  URL.revokeObjectURL(a.href)
}

export default function ChatPanel({ taskId, videoTitle, subtitleText, cleaned, onClose }) {
  const [messages, setMessages] = useState([])   // [{role, content, error?, usage?}]
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const listRef = useRef(null)

  // 挂载时恢复历史对话（持久化在服务端，关闭/刷新不丢）
  useEffect(() => {
    let cancelled = false
    api.getChat(taskId)
      .then(data => {
        if (!cancelled && data.messages?.length) setMessages(data.messages)
      })
      .catch(() => { /* 无历史或任务已过期，从空对话开始 */ })
    return () => { cancelled = true }
  }, [taskId])

  // 新消息/流式追加时滚到底部
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [messages, busy])

  /** 扣费完成后刷新导航栏余额（billing-changed 广播） */
  const notifyBilling = () => window.dispatchEvent(new CustomEvent('stellaris:billing-changed'))

  // 会话累计 token（输出 + 输入），显示在顶栏
  const totals = messages.reduce((acc, m) => {
    if (m.usage) {
      acc.prompt += m.usage.prompt_tokens
      acc.completion += m.usage.completion_tokens
    }
    return acc
  }, { prompt: 0, completion: 0 })

  // 本轮预计输入 tokens（发送前辅助决策；字幕全文含在 system 里每轮都发）
  // 估算：字符数 / 1.5（DeepSeek 中文折算，与 /api/estimate 同模型）
  const historyChars = messages.reduce((n, m) => n + (m.error ? 0 : m.content.length), 0)
  const estPromptTokens = Math.round(
    ((subtitleText?.length || 0) + historyChars + input.trim().length) / 1.5
  )
  // 折引力波（1 = 500 tokens，四成让利取整，与后端一致）
  const estGravity = Math.floor(estPromptTokens / 500) +
    (estPromptTokens % 500 > 200 ? 1 : 0)

  /** 流式追加最后一条 assistant 消息的内容 */
  const appendLast = (text) => {
    setMessages(prev => {
      const next = [...prev]
      const last = next[next.length - 1]
      next[next.length - 1] = { ...last, content: last.content + text }
      return next
    })
  }

  const send = async (text) => {
    const question = (text ?? input).trim()
    if (!question || busy || cleaned) return
    setInput('')
    // 后端只保留最近 8 条（与后端兜底一致）
    const history = messages
      .filter(m => !m.error)
      .slice(-8)
      .map(m => ({ role: m.role, content: m.content }))
    setMessages(prev => [...prev, { role: 'user', content: question }])
    setBusy(true)
    try {
      // 先占位空 assistant 气泡，流式逐段填充
      setMessages(prev => [...prev, { role: 'assistant', content: '' }])
      await api.chatStream(taskId, question, history, {
        onDelta: appendLast,
        onDone: (usage, charged) => {
          setMessages(prev => {
            const next = [...prev]
            next[next.length - 1] = { ...next[next.length - 1], usage, charged }
            return next
          })
          notifyBilling()   // 结算完成，刷新余额
        },
      })
    } catch (e) {
      setMessages(prev => {
        const next = [...prev]
        const last = next[next.length - 1]
        // 流中途失败：保留已收到的内容，标注错误
        next[next.length - 1] = {
          ...last,
          content: last.content || (e.message || 'AI 解读失败，请稍后重试'),
          error: true,
        }
        return next
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="chat-panel" style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      minHeight: 0,
    }}>
      {/* ── 顶栏 ── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingBottom: 12,
        borderBottom: '1px solid var(--hairline)',
        flexShrink: 0,
      }}>
        <span className="font-display" style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink)' }}>
          <span style={{ color: 'var(--accent)', marginRight: 6, fontFamily: "'Cormorant Garamond', serif" }}>✦</span>
          AI 解读
          {totals.prompt > 0 && (
            <span className="font-mono" style={{
              marginLeft: 10, fontSize: 11, fontWeight: 400, color: 'var(--mute)',
            }}>
              累计 {fmtTokens(totals.prompt + totals.completion)} tokens
            </span>
          )}
        </span>
        <div style={{ display: 'flex', gap: 4 }}>
          <Button
            type="text" size="small" icon={<DownloadOutlined />}
            disabled={messages.length === 0}
            onClick={() => downloadChatMd(videoTitle, messages.filter(m => !m.error))}
            title="导出对话为 Markdown"
          />
          <Button type="text" size="small" icon={<CloseOutlined />} onClick={onClose} title="收起" />
        </div>
      </div>

      {/* ── 消息列表 ── */}
      <div ref={listRef} style={{
        flex: 1,
        overflowY: 'auto',
        padding: '16px 2px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        minHeight: 0,
      }}>
        {messages.length === 0 && (
          <div className="chat-msg-enter" style={{ marginTop: 8 }}>
            <div style={{
              fontSize: 13, color: 'var(--mute)', lineHeight: 1.7, marginBottom: 14,
            }}>
              <InfoCircleOutlined style={{ marginRight: 6 }} />
              已读取本视频字幕，可以开始提问了
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {SUGGESTIONS.map(s => (
                <button
                  key={s}
                  className="chat-chip"
                  onClick={() => send(s)}
                  disabled={cleaned}
                >
                  <span>{s}</span>
                  <span className="chat-chip-cost">≈ {estGravity} 引力波</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div
            key={i}
            className="chat-msg-enter"
            style={{
              alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '92%',
            }}
          >
            <div style={m.role === 'user' ? {
              background: 'var(--accent)',
              color: '#fff',
              borderRadius: '14px 14px 4px 14px',
              padding: '9px 14px',
              fontSize: 14,
              lineHeight: 1.6,
            } : {
              background: m.error ? 'var(--error-bg)' : 'var(--surface-2)',
              border: m.error ? '1px solid #fecaca' : '1px solid var(--hairline)',
              color: m.error ? 'var(--error)' : 'var(--ink)',
              borderRadius: '14px 14px 14px 4px',
              padding: '10px 14px',
              fontSize: 14,
            }}>
              {m.role === 'user'
                ? m.content
                : (
                  <>
                    {m.content
                      ? <ReactMarkdown components={MD_COMPONENTS} remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>{m.content}</ReactMarkdown>
                      : (
                        <span style={{ display: 'inline-block', padding: '2px 4px' }}>
                          <span className="chat-dot" /><span className="chat-dot" /><span className="chat-dot" />
                        </span>
                      )
                    }
                    {m.usage && (
                      <div className="font-mono" style={{
                        marginTop: 8, paddingTop: 6,
                        borderTop: '1px dashed var(--hairline)',
                        fontSize: 11, color: 'var(--mute)',
                      }}>
                        ↑ {fmtTokens(m.usage.prompt_tokens)} 输入 · ↓ {fmtTokens(m.usage.completion_tokens)} 输出
                        {m.usage.cache_hit_tokens > 0 && (
                          <span style={{ color: 'var(--accent)', marginLeft: 6 }}>
                            <ThunderboltOutlined style={{ fontSize: 10, marginRight: 2 }} />
                            缓存 {Math.round(m.usage.cache_hit_tokens / m.usage.prompt_tokens * 100)}%
                          </span>
                        )}
                        {m.charged > 0 && (
                          <span style={{ color: 'var(--accent)', marginLeft: 6 }}>
                            · 扣 {m.charged} 引力波
                          </span>
                        )}
                      </div>
                    )}
                  </>
                )}
            </div>
          </div>
        ))}
      </div>

      {/* ── 输入区 ── */}
      <div style={{
        paddingTop: 12,
        borderTop: '1px solid var(--hairline)',
        flexShrink: 0,
        opacity: cleaned ? 0.4 : 1,
        pointerEvents: cleaned ? 'none' : 'auto',
      }}>
        {/* 发送前 token 预估（辅助决策；发送后气泡下方显示精确用量） */}
        <div className="font-mono" style={{
          fontSize: 11, color: 'var(--mute)', marginBottom: 8, textAlign: 'right',
        }}>
          本轮预计输入 ≈ {fmtTokens(estPromptTokens)} tokens（含字幕全文）≈ {estGravity} 引力波
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Input
            placeholder={cleaned ? '数据已清理，对话不可用' : '针对这个视频提问...'}
            value={input}
            onChange={e => setInput(e.target.value)}
            onPressEnter={() => send()}
            disabled={busy || cleaned}
            style={{ borderRadius: 'var(--r-input)' }}
          />
          <Button
            type="primary"
            icon={<SendOutlined />}
            onClick={() => send()}
            loading={busy}
            disabled={!input.trim() || cleaned}
            style={{ borderRadius: 'var(--r-btn)', flexShrink: 0 }}
          />
        </div>
      </div>
    </div>
  )
}
