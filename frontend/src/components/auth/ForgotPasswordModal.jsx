/**
 * 忘记密码弹窗 — 邮箱(预填) → 人机验证 → 验证码 → 新密码
 * 与设置页修改密码的验证码通道共用 reset-password 路由
 */
import { useState, useEffect } from 'react'
import { Button, Input, Modal, message } from 'antd'
import { authApi } from '../../hooks/api'
import TurnstileField from './TurnstileField'

export default function ForgotPasswordModal({ open, email: initialEmail, onClose }) {
  const [email, setEmail] = useState(initialEmail || '')
  const [code, setCode] = useState('')
  const [newPwd, setNewPwd] = useState('')
  const [turnstileToken, setTurnstileToken] = useState(null)
  const [codeSent, setCodeSent] = useState(false)
  const [countdown, setCountdown] = useState(0)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setEmail(initialEmail || '')
      setCode(''); setNewPwd(''); setCodeSent(false); setCountdown(0)
    }
  }, [open, initialEmail])

  useEffect(() => {
    if (countdown <= 0) return
    const t = setTimeout(() => setCountdown(c => c - 1), 1000)
    return () => clearTimeout(t)
  }, [countdown])

  const sendCode = async () => {
    if (!email.trim()) { message.warning('请输入邮箱地址'); return }
    if (!turnstileToken) { message.warning('请完成人机验证'); return }
    try {
      await authApi.sendCode(email.trim(), turnstileToken)
      setCodeSent(true)
      setCountdown(60)
      message.success(`验证码已发送至 ${email.trim()}`)
    } catch (e) {
      message.error(e.message)
    }
  }

  const submit = async () => {
    if (newPwd.length < 8) { message.warning('新密码至少 8 位'); return }
    setSaving(true)
    try {
      await authApi.resetPassword(email.trim(), code, newPwd)
      message.success('密码已重置，请用新密码登录')
      onClose()
    } catch (e) {
      message.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onCancel={onClose} title="忘记密码" footer={null} width={400}>
      <p style={{ fontSize: 13, color: 'var(--mute)', marginTop: 0 }}>
        输入注册时使用的邮箱，我们会把验证码发给你
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Input
          placeholder="邮箱地址" value={email}
          onChange={e => setEmail(e.target.value)}
        />
        <TurnstileField onToken={setTurnstileToken} />
        <div style={{ display: 'flex', gap: 8 }}>
          <Input
            placeholder="6 位验证码" value={code} maxLength={6}
            onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
          />
          <Button onClick={sendCode} disabled={countdown > 0} style={{ flexShrink: 0 }}>
            {countdown > 0 ? `${countdown}s` : codeSent ? '重新发送' : '发送验证码'}
          </Button>
        </div>
        <Input.Password
          placeholder="新密码（至少 8 位，含字母+数字+符号）"
          value={newPwd} onChange={e => setNewPwd(e.target.value)}
        />
        <Button
          type="primary" block loading={saving}
          disabled={!code || !newPwd} onClick={submit}
        >
          重置密码
        </Button>
      </div>
    </Modal>
  )
}
