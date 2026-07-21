/**
 * 兑换码弹窗 — 输入 → 预览 → 二次确认 → 核销
 * 同一套码系统：Stella 邀请码 / 爱发电兜底发码 / 活动送码
 */
import { useState } from 'react'
import { Modal, Input, Button, message } from 'antd'
import { GiftOutlined } from '@ant-design/icons'
import api from '../hooks/api'
import { tierMeta } from '../utils/tier'

export default function RedeemModal({ open, onClose, onDone }) {
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)

  const handleRedeem = async () => {
    const c = code.trim().toUpperCase()
    if (!c) { message.warning('请输入兑换码'); return }
    setLoading(true)
    try {
      // ① 预览（二次确认的依据）
      const p = await api.redeemPreview(c)
      const meta = tierMeta(p.tier)
      const daysText = p.days == null ? '永久' : `${p.days} 天`
      Modal.confirm({
        title: '确认兑换？',
        content: `将为你的账号开通 ${meta.label}${meta.cn ? `（${meta.cn}）` : ''} · ${daysText}，兑换后立即生效。`,
        okText: '确认兑换',
        cancelText: '再想想',
        onOk: async () => {
          try {
            await api.redeem(c)
            message.success(`兑换成功！${meta.label} 权益已生效`)
            window.dispatchEvent(new CustomEvent('stellaris:billing-changed'))
            setCode('')
            onDone?.()
            onClose()
          } catch (e) {
            message.error(e.message)
          }
        },
      })
    } catch (e) {
      message.error(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal
      open={open} onCancel={onClose} footer={null} width={400}
      title={<span><GiftOutlined style={{ marginRight: 8, color: 'var(--accent)' }} />兑换码</span>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '8px 0 4px' }}>
        <Input
          placeholder="输入兑换码（如 XXXX-XXXX-XXXX）"
          value={code}
          onChange={e => setCode(e.target.value.toUpperCase())}
          onPressEnter={handleRedeem}
          maxLength={32}
          className="font-mono"
          style={{ letterSpacing: 1 }}
        />
        <div style={{ fontSize: 11, color: 'var(--mute)', lineHeight: 1.7 }}>
          会员兑换码 / 邀请码在此激活 · 兑换前会先向你确认权益内容
        </div>
        <Button type="primary" block loading={loading} onClick={handleRedeem}>
          兑换
        </Button>
      </div>
    </Modal>
  )
}
