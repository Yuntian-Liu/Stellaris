/**
 * 我的工单弹窗（V0.9.4）
 * 列表态：滚动列表（标题/分类/盖章状态/时间/未读红点）
 * 详情态：完整表单内容 + 管理员回复；点开即标记已读消红点
 */
import { useState, useEffect, useCallback } from 'react'
import { Modal, Empty, Spin, Tag, Button } from 'antd'
import { ArrowLeftOutlined } from '@ant-design/icons'
import { ticketApi } from '../hooks/api'
import TicketStatusStamp from './TicketStatusStamp'

const CATEGORY_TAG = {
  bug: { color: 'error', text: 'Bug 反馈' },
  suggestion: { color: 'geekblue', text: '功能建议' },
  other: { color: 'default', text: '其他' },
}

function fmtTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`
}

export default function TicketListModal({ open, onClose, refreshKey, onTicketRead }) {
  const [items, setItems] = useState(null)      // null=loading, []=空
  const [detail, setDetail] = useState(null)    // 工单详情（null=列表态）
  const [loadingDetail, setLoadingDetail] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await ticketApi.listMine()
      setItems(r.items || [])
    } catch {
      setItems([])
    }
  }, [])

  useEffect(() => {
    if (open) {
      setItems(null)
      setDetail(null)
      load()
    }
  }, [open, load, refreshKey])

  // 点开某条 → 拉详情（后端标记已读）→ 切详情态 → 刷新列表消红点
  const openDetail = async (tid) => {
    setLoadingDetail(true)
    try {
      const t = await ticketApi.getDetail(tid)
      setDetail(t)
      // 详情已读后刷新列表的红点状态
      setItems(prev => (prev || []).map(x => x.id === tid ? { ...x, unread: false } : x))
      // 通知上层刷新未读（红点消掉）
      onTicketRead?.()
    } catch {
      // 静默
    } finally {
      setLoadingDetail(false)
    }
  }

  const handleClose = () => { setDetail(null); onClose() }

  // ── 详情态 ──
  if (detail) {
    return (
      <Modal open={open} onCancel={handleClose} footer={null} width={520} centered destroyOnClose
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Button type="text" size="small" icon={<ArrowLeftOutlined />}
              onClick={() => setDetail(null)} />
            <span className="font-display">工单详情</span>
          </div>
        }
      >
        <div style={{ padding: '4px 0' }}>
          <div className="font-display font-display-xs" style={{ marginBottom: 8 }}>{detail.title}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <Tag color={CATEGORY_TAG[detail.category]?.color}>{CATEGORY_TAG[detail.category]?.text}</Tag>
            <TicketStatusStamp status={detail.status} />
            <span style={{ fontSize: 11, color: 'var(--mute)', marginLeft: 'auto' }}>
              {fmtTime(detail.created_at)}
            </span>
          </div>

          <div style={{ fontSize: 13, color: 'var(--body)', lineHeight: 1.8, marginBottom: 12 }}>
            {detail.description}
          </div>

          {(detail.occur_at || detail.repro_steps) && (
            <div style={{ fontSize: 12, color: 'var(--mute)', lineHeight: 1.8, marginBottom: 12 }}>
              {detail.occur_at && <div>发生时间：{detail.occur_at}</div>}
              {detail.repro_steps && <div>复现次数：{detail.repro_steps}</div>}
            </div>
          )}

          {detail.has_log && (
            <div style={{ fontSize: 11, color: 'var(--mute)', marginBottom: 12 }}>
              已附带诊断日志
            </div>
          )}

          {/* 管理员回复 */}
          {detail.admin_reply && (
            <div style={{
              background: 'var(--accent-light)', borderRadius: 'var(--r-input)',
              padding: '12px 14px', marginBottom: 8,
            }}>
              <div style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 500, marginBottom: 6 }}>
                开发者回复
              </div>
              <div style={{ fontSize: 13, color: 'var(--ink)', lineHeight: 1.8, whiteSpace: 'pre-wrap' }}>
                {detail.admin_reply}
              </div>
              {detail.replied_at && (
                <div style={{ fontSize: 11, color: 'var(--mute)', marginTop: 6 }}>
                  {fmtTime(detail.replied_at)}
                </div>
              )}
            </div>
          )}
        </div>
      </Modal>
    )
  }

  // ── 列表态 ──
  return (
    <Modal open={open} onCancel={handleClose} footer={null} width={520} centered destroyOnClose
      title={<span className="font-display">我的工单</span>}
    >
      <div style={{ padding: '4px 0' }}>
        {items === null ? (
          <div style={{ textAlign: 'center', padding: '40px 0' }}><Spin /></div>
        ) : items.length === 0 ? (
          <Empty description="暂无工单" style={{ padding: '32px 0' }} />
        ) : (
          <div style={{ maxHeight: '60vh', overflowY: 'auto', margin: '0 -8px' }}>
            {items.map((it, i) => (
              <div key={it.id} onClick={() => openDetail(it.id)}
                style={{
                  padding: '12px 12px', cursor: 'pointer', borderRadius: 'var(--r-input)',
                  borderTop: i === 0 ? 'none' : '1px solid var(--hairline)',
                  display: 'flex', alignItems: 'center', gap: 10,
                  transition: 'background 0.15s',
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = 'var(--surface-2)'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 13, color: 'var(--ink)', fontWeight: 500,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {it.title}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                    <Tag style={{ margin: 0, fontSize: 10, lineHeight: '16px', padding: '0 6px' }}
                      color={CATEGORY_TAG[it.category]?.color}>
                      {CATEGORY_TAG[it.category]?.text}
                    </Tag>
                    <span style={{ fontSize: 11, color: 'var(--mute)' }}>{fmtTime(it.created_at)}</span>
                  </div>
                </div>
                <TicketStatusStamp status={it.status} />
                {it.unread && (
                  <span style={{
                    width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)',
                    flexShrink: 0,
                  }} />
                )}
              </div>
            ))}
          </div>
        )}
        {loadingDetail && <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--mute)', padding: 8 }}>加载中…</div>}
      </div>
    </Modal>
  )
}
