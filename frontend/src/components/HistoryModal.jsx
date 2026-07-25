/**
 * 历史记录弹窗 — 提取历史列表（点记录直接回结果页）
 * 记录随任务清理联动删除（免费档 1 小时）；404 的记录标记已失效
 */
import { useState, useEffect } from 'react'
import { Modal, Button, message } from 'antd'
import { RightOutlined, HistoryOutlined, CopyOutlined } from '@ant-design/icons'
import api from '../hooks/api'
import { RETENTION_COPY } from '../utils/tier'
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

export default function HistoryModal({ open, onClose, onOpenRecord }) {
  const [records, setRecords] = useState(null)
  const [opening, setOpening] = useState(null)
  const [retentionCopy, setRetentionCopy] = useState(RETENTION_COPY.free)
  const { user } = useAuth()

  useEffect(() => {
    if (!open) return
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

  const openRecord = async (taskId) => {
    setOpening(taskId)
    // 记录失效时从列表移除；匿名还要同步清 localStorage，否则下次打开又出现
    const drop = () => {
      setRecords(prev => prev.filter(r => r.task_id !== taskId))
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

  return (
    <Modal open={open} onCancel={onClose} footer={null} width={480} centered
      title={<span><HistoryOutlined style={{ marginRight: 8 }} />提取历史</span>}
    >
      <div style={{ maxHeight: '55vh', overflowY: 'auto' }}>
        {records === null && (
          <div style={{ textAlign: 'center', color: 'var(--mute)', padding: '24px 0', fontSize: 13 }}>
            加载中...
          </div>
        )}
        {records?.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--mute)', padding: '24px 0', fontSize: 13, lineHeight: 1.8 }}>
            暂无提取记录
            <div style={{ fontSize: 11, marginTop: 4, color: 'var(--accent)', opacity: 0.85 }}>
              {retentionCopy}
            </div>
          </div>
        )}
        {records?.map(r => (
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
              <div style={{ fontSize: 11, color: 'var(--mute)', marginTop: 3, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="font-mono" style={{ fontSize: 10 }}>{r.task_id}</span>
                <CopyOutlined style={{ fontSize: 10, cursor: 'pointer' }}
                  onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(r.task_id); message.success('已复制任务 ID') }} />
                <span>· {r.source_platform} · {timeAgo(r.created_at)}</span>
              </div>
            </div>
            {opening === r.task_id
              ? <span style={{ fontSize: 11, color: 'var(--mute)' }}>打开中...</span>
              : <RightOutlined style={{ fontSize: 11, color: 'var(--hairline-strong)' }} />}
          </div>
        ))}
      </div>
    </Modal>
  )
}
