/**
 * 管理 PIN 弹窗（V0.9.0）— 敏感操作二次验证
 * mode='set'：首次设置（输两遍 6 位数字）；mode='verify'：操作前验证（单框 + 确认）
 * onOk(pin) 返回 true 才关闭（后端 409/403/423 错误由调用方 message 提示，弹窗保持）
 */
import { useState, useEffect } from 'react'
import { Modal, Input, Button, message } from 'antd'

export default function PinModal({ open, mode = 'verify', onOk, onCancel }) {
  const [pin, setPin] = useState('')
  const [pin2, setPin2] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) { setPin(''); setPin2('') }
  }, [open])

  const submit = async () => {
    if (!/^\d{6}$/.test(pin)) return message.warning('PIN 为 6 位纯数字')
    if (mode === 'set' && pin !== pin2) return message.warning('两次输入不一致')
    setBusy(true)
    try {
      await onOk(pin)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      title={mode === 'set' ? '设置管理 PIN' : '敏感操作验证'}
      onCancel={onCancel}
      footer={null}
      width={320}
      centered
      destroyOnHidden
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 0 2px' }}>
        <div style={{ fontSize: 12, color: 'var(--mute)', lineHeight: 1.7 }}>
          {mode === 'set'
            ? 'PIN 用于调档 / 调余额 / 发码 / 补发等敏感操作的二次验证，请妥善保管。'
            : '请输入管理 PIN 以继续操作。连续 5 次错误将锁定 10 分钟。'}
        </div>
        <Input.Password
          placeholder="6 位数字 PIN"
          value={pin}
          maxLength={6}
          inputMode="numeric"
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          onPressEnter={mode === 'verify' ? submit : undefined}
          autoFocus
        />
        {mode === 'set' && (
          <Input.Password
            placeholder="再输一遍确认"
            value={pin2}
            maxLength={6}
            inputMode="numeric"
            onChange={(e) => setPin2(e.target.value.replace(/\D/g, ''))}
            onPressEnter={submit}
          />
        )}
        <Button type="primary" block loading={busy} onClick={submit} style={{ height: 40 }}>
          确认
        </Button>
      </div>
    </Modal>
  )
}
