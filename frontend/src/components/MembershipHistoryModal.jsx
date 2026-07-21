/**
 * 会员开通记录弹窗 — 爱发电订单 + 兑换码兑换（时间倒序）
 * 设置主页「开通记录」入口；会员权益二级界面内的板块与此同源（getMembershipHistory）
 */
import { useState, useEffect } from 'react'
import { Modal } from 'antd'
import { CreditCardOutlined } from '@ant-design/icons'
import api from '../hooks/api'
import { tierMeta } from '../utils/tier'

export default function MembershipHistoryModal({ open, onClose }) {
  const [items, setItems] = useState(null)

  useEffect(() => {
    if (!open) return
    api.getMembershipHistory()
      .then(d => setItems(d.items))
      .catch(() => setItems([]))
  }, [open])

  return (
    <Modal open={open} onCancel={onClose} footer={null} width={440}
      title={<span><CreditCardOutlined style={{ marginRight: 8, color: 'var(--accent)' }} />开通记录</span>}
    >
      <div style={{ maxHeight: '50vh', overflowY: 'auto' }}>
        {items === null && (
          <div style={{ textAlign: 'center', color: 'var(--mute)', padding: '24px 0', fontSize: 13 }}>
            加载中...
          </div>
        )}
        {items?.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--mute)', padding: '24px 0', fontSize: 13, lineHeight: 1.8 }}>
            暂无开通记录
            <div style={{ fontSize: 11, marginTop: 4, color: 'var(--accent)', opacity: 0.85 }}>
              你的第一段星轨，等你启程
            </div>
          </div>
        )}
        {items?.map((it, i) => {
          const meta = tierMeta(it.tier)
          const d = it.time ? new Date(it.time) : null
          return (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '10px 4px', fontSize: 12.5,
              borderTop: i === 0 ? 'none' : '1px solid var(--hairline)',
            }}>
              <span style={{
                fontSize: 11, fontWeight: 500, color: meta.color,
                background: meta.bg, borderRadius: 9999, padding: '1px 8px',
                flexShrink: 0,
              }}>{meta.label}</span>
              <span style={{ color: 'var(--body)', flex: 1 }}>
                {it.days == null ? '永久' : `${it.days} 天`}
                <span style={{ color: 'var(--mute)', marginLeft: 8 }}>{it.source}</span>
              </span>
              <span className="font-mono" style={{ color: 'var(--mute)', fontSize: 11, flexShrink: 0 }}>
                {it.amount ? `¥${it.amount} · ` : ''}
                {d ? `${d.getMonth() + 1}月${d.getDate()}日` : ''}
              </span>
            </div>
          )
        })}
      </div>
    </Modal>
  )
}
