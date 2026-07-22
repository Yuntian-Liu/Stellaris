/**
 * 兑换码弹窗 — 输入 → 预览（含发放模式/额度）→ 二次确认（有感：同意《会员协议》）→ 核销
 * 同一套码系统：Stella 邀请码 / 爱发电兜底发码 / 活动送码
 */
import { useState } from 'react'
import { Modal, Input, Button, Checkbox, message } from 'antd'
import { GiftOutlined } from '@ant-design/icons'
import api from '../hooks/api'
import { tierMeta } from '../utils/tier'
import AgreementModal from './AgreementModal'

export default function RedeemModal({ open, onClose, onDone }) {
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState(null)      // 预览结果（含 grant_mode/quantum_grant/gravity_grant）
  const [agreed, setAgreed] = useState(false)
  const [agreementOpen, setAgreementOpen] = useState(false)
  const [redeeming, setRedeeming] = useState(false)

  const reset = () => {
    setCode(''); setPreview(null); setAgreed(false)
    setLoading(false); setRedeeming(false)
  }

  // 第一步：预览权益（不核销）
  const handlePreview = async () => {
    const c = code.trim().toUpperCase()
    if (!c) { message.warning('请输入兑换码'); return }
    setLoading(true)
    try {
      const p = await api.redeemPreview(c)
      setPreview(p)
      setAgreed(false)
    } catch (e) {
      message.error(e.message)
    } finally {
      setLoading(false)
    }
  }

  // 第二步：确认核销（须先勾选同意《会员协议》）
  const handleConfirm = async () => {
    if (!agreed) { message.warning('请先阅读并同意《会员协议》'); return }
    setRedeeming(true)
    try {
      await api.redeem(code.trim().toUpperCase())
      const meta = tierMeta(preview.tier)
      message.success(`兑换成功！${meta.label} 权益已生效`)
      window.dispatchEvent(new CustomEvent('stellaris:billing-changed'))
      reset()
      onDone?.()
      onClose()
    } catch (e) {
      message.error(e.message)
    } finally {
      setRedeeming(false)
    }
  }

  const handleClose = () => { reset(); onClose() }

  const meta = preview ? tierMeta(preview.tier) : null
  const daysText = preview ? (preview.days == null ? '永久' : `${preview.days} 天`) : ''
  const isLump = preview?.grant_mode === 'lump'

  return (
    <>
      <Modal open={open} onCancel={handleClose} footer={null} width={400} centered
        title={<span><GiftOutlined style={{ marginRight: 8, color: 'var(--accent)' }} />兑换码</span>}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '8px 0 4px' }}>
          <Input
            placeholder="输入兑换码（如 XXXX-XXXX-XXXX）"
            value={code}
            onChange={e => setCode(e.target.value.toUpperCase())}
            onPressEnter={handlePreview}
            maxLength={32}
            className="font-mono"
            style={{ letterSpacing: 1 }}
          />
          <div style={{ fontSize: 11, color: 'var(--mute)', lineHeight: 1.7 }}>
            会员兑换码 / 邀请码在此激活 · 兑换前会先向你确认权益内容
          </div>
          <Button type="primary" block loading={loading} onClick={handlePreview}>
            查看权益
          </Button>
        </div>
      </Modal>

      {/* 二次确认弹窗（受控，有感：按发放模式展示明细 + 同意《会员协议》） */}
      <Modal open={!!preview} onCancel={() => setPreview(null)} width={420} centered footer={null}
        title="确认兑换">
        {preview && (
          <div style={{ padding: '4px 0' }}>
            <div style={{ fontSize: 14, color: 'var(--ink)', marginBottom: 10 }}>
              将为你的账号开通 <strong>{meta.label}</strong>{meta.cn ? `（${meta.cn}）` : ''} · {daysText}
            </div>
            <div style={{
              fontSize: 13, color: 'var(--body)', lineHeight: 1.75,
              background: 'var(--surface-2)', padding: '10px 12px',
              borderRadius: 'var(--r-input)', marginBottom: 14,
            }}>
              {isLump
                ? `一次性发放：${preview.quantum_grant} 量子波（入永久钱包）+ ${preview.gravity_grant} 引力波，不参与周期重发，用完即止；分钟数随档位到期恢复免费档。`
                : `常规发放：量子波按 ${meta.label} 档位每周重置、引力波按会员周期发放。`}
            </div>
            <Checkbox checked={agreed} onChange={(e) => setAgreed(e.target.checked)}>
              我已阅读并同意
              <a onClick={() => setAgreementOpen(true)} style={{ color: 'var(--accent)', marginLeft: 4 }}>《会员协议》</a>
            </Checkbox>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
              <Button onClick={() => setPreview(null)}>取消</Button>
              <Button type="primary" loading={redeeming} disabled={!agreed} onClick={handleConfirm}>
                确认兑换
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <AgreementModal open={agreementOpen} type="membership" onClose={() => setAgreementOpen(false)} />
    </>
  )
}
