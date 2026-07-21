/**
 * 历史记录弹窗 — 提取历史列表（点记录直接回结果页）
 * 记录随任务清理联动删除（免费档 1 小时）；404 的记录标记已失效
 */
import { useState, useEffect } from 'react'
import { Modal, Button, message } from 'antd'
import { RightOutlined, HistoryOutlined } from '@ant-design/icons'
import api from '../hooks/api'
import { RETENTION_COPY } from '../utils/tier'

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

  useEffect(() => {
    if (!open) return
    api.getHistory()
      .then(d => setRecords(d.records))
      .catch(() => setRecords([]))
    // 空态文案按档位（星空语境，见 utils/tier.js RETENTION_COPY）
    api.getBilling()
      .then(b => setRetentionCopy(RETENTION_COPY[b.tier] || RETENTION_COPY.free))
      .catch(() => {})
  }, [open])

  const openRecord = async (taskId) => {
    setOpening(taskId)
    try {
      const data = await api.getTask(taskId)
      if (data.status !== 'completed') {
        message.info('该记录已失效（数据已清理或过期）')
        setRecords(prev => prev.filter(r => r.task_id !== taskId))
        return
      }
      onOpenRecord(data)
      onClose()
    } catch {
      message.info('该记录已失效（数据已清理或过期）')
      setRecords(prev => prev.filter(r => r.task_id !== taskId))
    } finally {
      setOpening(null)
    }
  }

  return (
    <Modal open={open} onCancel={onClose} footer={null} width={480}
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
              <div style={{ fontSize: 11, color: 'var(--mute)', marginTop: 3 }}>
                {r.source_platform} · {timeAgo(r.created_at)}
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
