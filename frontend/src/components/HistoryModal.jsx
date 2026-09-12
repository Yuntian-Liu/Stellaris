/**
 * 历史记录弹窗 — 提取历史列表（点记录直接回结果页）
 * 记录随任务清理联动删除（免费档 1 小时）；404 的记录标记已失效
 * 双引擎搜索：SQL 输入即搜（免费）/ AI 语义搜索（固定 1 引力波，显式按钮触发；
 * SQL 零结果空态引导 AI——付费永远是主动选择）
 */
import { useState, useEffect } from 'react'
import { Modal, Button, Input, Popconfirm, Tooltip, message } from 'antd'
import {
  RightOutlined, HistoryOutlined, CopyOutlined,
  SearchOutlined, CloseOutlined, ThunderboltOutlined,
} from '@ant-design/icons'
import api from '../hooks/api'
import { RETENTION_COPY } from '../utils/tier'
import { clientLog } from '../utils/clientLog'
import { readAnonHistory, removeAnonHistory } from '../utils/anonHistory'
import { useAuth } from '../contexts/AuthContext'

// 匿名空态文案：本地记忆 + 转化引导（免费版同为 1h，长保留是会员权益，不承诺给"登录"）
const ANON_COPY = '记录只保存在这台浏览器 · 提取内容保留 1 小时 · 会员历史最长永久保留'

function timeAgo(iso) {
  if (!iso) return ''
  const diff = (Date.now() - new Date(iso).getTime()) / 1000
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  return `${Math.floor(diff / 86400)} 天前`
}

/** snippet 命中词高亮（主题紫加粗） */
function Highlighted({ text, terms }) {
  if (!text || !terms?.length) return text || null
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const re = new RegExp(`(${escaped.join('|')})`, 'g')
  return text.split(re).map((part, i) =>
    terms.includes(part)
      ? <span key={i} style={{ color: 'var(--accent)', fontWeight: 600 }}>{part}</span>
      : part
  )
}

export default function HistoryModal({ open, onClose, onOpenRecord }) {
  const [records, setRecords] = useState(null)
  const [opening, setOpening] = useState(null)
  const [retentionCopy, setRetentionCopy] = useState(RETENTION_COPY.free)
  const { user } = useAuth()

  // ── 双引擎搜索状态 ──
  const [query, setQuery] = useState('')
  const [sqlResults, setSqlResults] = useState(null)   // null = 未在搜索
  const [aiResults, setAiResults] = useState(null)     // 非 null = 展示 AI 精排结果
  const [aiLoading, setAiLoading] = useState(false)
  const [aiStage, setAiStage] = useState(0)            // 假动画阶段（读标题→读摘要→精排）

  // AI 搜索假动画文案（真实步骤不严格对应，缓解等待焦虑——碳碳定稿）
  const AI_STAGES = ['正在读取标题…', '正在读取摘要…', 'AI 语义精排中…']

  useEffect(() => {
    if (!open) return
    // 每次打开清空搜索态
    setQuery(''); setSqlResults(null); setAiResults(null)
    if (!user) {
      // 匿名：读浏览器本地记忆（字段对齐服务端记录格式）
      setRecords(readAnonHistory().map(r => ({
        task_id: r.task_id,
        title: r.title,
        source_platform: r.platform,
        created_at: r.created_at,
      })))
      setRetentionCopy(ANON_COPY)
      return
    }
    api.getHistory()
      .then(d => setRecords(d.records))
      .catch(() => setRecords([]))
    // 空态文案按档位（星空语境，见 utils/tier.js RETENTION_COPY）
    api.getBilling()
      .then(b => setRetentionCopy(RETENTION_COPY[b.tier] || RETENTION_COPY.free))
      .catch(() => {})
  }, [open, user])

  // SQL 引擎：输入即搜（防抖 300ms）；匿名走本地标题过滤
  useEffect(() => {
    if (!open) return
    const q = query.trim()
    setAiResults(null)   // 输入变化即作废 AI 结果（回到 SQL 语境）
    if (!q) { setSqlResults(null); return }
    const t = setTimeout(async () => {
      if (!user) {
        const hits = readAnonHistory()
          .filter(r => (r.title || '').includes(q))
          .map(r => ({
            task_id: r.task_id, title: r.title,
            source_platform: r.platform, created_at: r.created_at,
            snippet: '', matched: [q],
          }))
        setSqlResults(hits)
        return
      }
      try {
        const d = await api.searchHistory(q)
        setSqlResults(d.items)
      } catch {
        setSqlResults([])
      }
    }, 300)
    return () => clearTimeout(t)
  }, [query, open, user])

  // AI 语义搜索（固定 1 引力波，失败零扣费；假动画轮转缓解等待）
  const runAISearch = async () => {
    setAiLoading(true)
    setAiStage(0)
    clientLog.add('search', 'AI 语义搜索触发')   // 随诊断包导出（不含搜索词，保护隐私）
    const timer = setInterval(
      () => setAiStage((s) => Math.min(s + 1, AI_STAGES.length - 1)), 900
    )
    try {
      const d = await api.searchHistoryAI(query.trim())
      setAiResults(d.items)
      window.dispatchEvent(new CustomEvent('stellaris:billing-changed'))
      if (!d.items.length) message.info(d.msg || 'AI 没有找到相关记录')
    } catch (e) {
      clientLog.add('search', `AI 语义搜索失败: ${e.message}`.slice(0, 200))
      message.error(e.message)
    } finally {
      clearInterval(timer)
      setAiLoading(false)
    }
  }

  const openRecord = async (taskId) => {
    setOpening(taskId)
    // 记录失效时从列表移除；匿名还要同步清 localStorage，否则下次打开又出现
    const drop = () => {
      setRecords(prev => prev?.filter(r => r.task_id !== taskId) ?? prev)
      setSqlResults(prev => prev?.filter(r => r.task_id !== taskId) ?? prev)
      setAiResults(prev => prev?.filter(r => r.task_id !== taskId) ?? prev)
      if (!user) removeAnonHistory(taskId)
    }
    try {
      const data = await api.getTask(taskId)
      if (data.status !== 'completed') {
        message.info('该记录已失效（数据已清理或过期）')
        drop()
        return
      }
      onOpenRecord(data)
      onClose()
    } catch {
      message.info('该记录已失效（数据已清理或过期）')
      drop()
    } finally {
      setOpening(null)
    }
  }

  // 展示数据源：AI 结果 > SQL 结果 > 完整列表
  const showing = aiResults ?? sqlResults ?? records
  const searching = query.trim().length > 0

  const aiButton = user ? (
    <Popconfirm
      title="AI 语义搜索 · 1 引力波/次"
      description="失败不扣费"
      okText="开始"
      cancelText="取消"
      onConfirm={() => { runAISearch() }}
    >
      <Tooltip title="AI 语义搜索 · 1 引力波/次">
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 3,
          fontSize: 11, fontWeight: 600, color: 'var(--accent)',
          cursor: 'pointer', padding: '2px 6px',
          background: 'var(--accent-light)', borderRadius: 6,
        }}>
          <ThunderboltOutlined style={{ fontSize: 10 }} />AI
        </span>
      </Tooltip>
    </Popconfirm>
  ) : null

  return (
    <Modal open={open} onCancel={onClose} footer={null} width={480} centered
      title={<span><HistoryOutlined style={{ marginRight: 8 }} />提取历史</span>}
    >
      {/* 搜索框（一行 36px；AI 按钮内嵌右侧，不占新行） */}
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="搜索标题或字幕内容…"
        prefix={<SearchOutlined style={{ color: 'var(--mute)', fontSize: 12 }} />}
        suffix={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {query && (
              <CloseOutlined
                style={{ fontSize: 11, color: 'var(--mute)', cursor: 'pointer' }}
                onClick={() => setQuery('')}
              />
            )}
            {aiButton}
          </span>
        }
        style={{ marginBottom: 10, borderRadius: 'var(--r-input)' }}
        allowClear={false}
      />

      <div style={{ maxHeight: '55vh', overflowY: 'auto' }}>
        {aiLoading ? (
          /* AI 搜索假动画：读标题 → 读摘要 → 精排（两种触发路径统一在此呈现） */
          <div className="ai-search-loading" style={{ textAlign: 'center', padding: '36px 0' }}>
            <ThunderboltOutlined style={{ fontSize: 18, color: 'var(--accent)' }} />
            <div
              key={aiStage}
              className="ai-stage-text"
              style={{ fontSize: 12.5, color: 'var(--mute)', marginTop: 10 }}
            >
              {AI_STAGES[aiStage]}
            </div>
            <style>{`
              .ai-search-loading { animation: aiPulse 1.2s ease-in-out infinite; }
              @keyframes aiPulse { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
              .ai-stage-text { animation: aiStageIn 0.3s ease both; }
              @keyframes aiStageIn {
                from { opacity: 0; transform: translateY(4px); }
                to   { opacity: 1; transform: none; }
              }
              @media (prefers-reduced-motion: reduce) {
                .ai-search-loading, .ai-stage-text { animation: none !important; }
              }
            `}</style>
          </div>
        ) : (
          <>
        {showing === null && (
          <div style={{ textAlign: 'center', color: 'var(--mute)', padding: '24px 0', fontSize: 13 }}>
            加载中...
          </div>
        )}
        {showing?.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--mute)', padding: '24px 0', fontSize: 13, lineHeight: 1.8 }}>
            {searching ? (
              <>
                没有找到相关记录
                {user && !aiResults && (
                  <div style={{ marginTop: 10 }}>
                    <Popconfirm
                      title="AI 语义搜索 · 1 引力波/次"
                      description="失败不扣费"
                      okText="开始"
                      cancelText="取消"
                      onConfirm={() => { runAISearch() }}
                    >
                      <Button size="small" type="primary" ghost icon={<ThunderboltOutlined />}>
                        试试 AI 语义搜索
                      </Button>
                    </Popconfirm>
                  </div>
                )}
              </>
            ) : (
              <>
                暂无提取记录
                <div style={{ fontSize: 11, marginTop: 4, color: 'var(--accent)', opacity: 0.85 }}>
                  {retentionCopy}
                </div>
              </>
            )}
          </div>
        )}
        {aiResults && aiResults.length > 0 && (
          <div style={{ fontSize: 11, color: 'var(--mute)', margin: '0 2px 8px' }}>
            <ThunderboltOutlined style={{ marginRight: 4, color: 'var(--accent)' }} />
            AI 语义搜索结果（按相关度排序）
          </div>
        )}
        {showing?.map(r => (
          <div
            key={r.task_id}
            onClick={() => openRecord(r.task_id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '10px 12px', marginBottom: 6,
              border: '1px solid var(--hairline)',
              borderRadius: 'var(--r-input)',
              cursor: 'pointer',
              transition: 'border-color 0.15s, background 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent)' }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--hairline)' }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: 13, fontWeight: 500, color: 'var(--ink)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {r.title}
              </div>
              {/* SQL 命中片段 / AI 相关理由 */}
              {r.snippet && (
                <div style={{
                  fontSize: 11, color: 'var(--mute)', marginTop: 3, lineHeight: 1.6,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  <Highlighted text={r.snippet} terms={r.matched} />
                </div>
              )}
              {r.reason && (
                <div style={{
                  fontSize: 11, color: 'var(--accent)', marginTop: 3, opacity: 0.85,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {r.reason}
                </div>
              )}
              <div style={{ fontSize: 11, color: 'var(--mute)', marginTop: 3, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="font-mono" style={{ fontSize: 10 }}>{r.task_id}</span>
                <CopyOutlined style={{ fontSize: 10, cursor: 'pointer' }}
                  onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(r.task_id); message.success('已复制任务 ID') }} />
                <span>· {r.source_platform} · {timeAgo(r.created_at)}</span>
              </div>
            </div>
            {opening === r.task_id || (aiLoading && aiResults === null)
              ? <span style={{ fontSize: 11, color: 'var(--mute)' }}>{opening === r.task_id ? '打开中...' : ''}</span>
              : <RightOutlined style={{ fontSize: 11, color: 'var(--hairline-strong)' }} />}
          </div>
        ))}
          </>
        )}
      </div>
    </Modal>
  )
}
