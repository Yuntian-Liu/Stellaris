/**
 * 忘记密码弹窗 — 邮箱(预填) → 人机验证 → 验证码 → 新密码
 * 与设置页修改密码的验证码通道共用 reset-password 路由
 */
import { useState, useEffect } from 'react'
import { Button, Modal, message } from 'antd'
import { authApi } from '../../hooks/api'
import CaptchaField from './CaptchaField'
import OtpInput from '../bencho/OtpInput'
import LabelInput from '../bencho/LabelInput'

export default function ForgotPasswordModal({ open, email: initialEmail, onClose }) {
  const [email, setEmail] = useState(initialEmail || '')
  const [code, setCode] = useState('')
  const [newPwd, setNewPwd] = useState('')
  const [captcha, setCaptcha] = useState(null)         // 图形验证码（V1.2.2）
  const [captchaKey, setCaptchaKey] = useState(0)
  const [codeSent, setCodeSent] = useState(false)
  const [countdown, setCountdown] = useState(0)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setEmail(initialEmail || '')
      setCode(''); setNewPwd(''); setCodeSent(false); setCountdown(0)
      setCaptcha(null); setCaptchaKey(k => k + 1)   // 重开弹窗换新题（票据一次性+5 分钟过期）
    }
  }, [open, initialEmail])

  useEffect(() => {
    if (countdown <= 0) return
    const t = setTimeout(() => setCountdown(c => c - 1), 1000)
    return () => clearTimeout(t)
  }, [countdown])

  const sendCode = async () => {
    if (!email.trim()) { message.warning('请输入邮箱地址'); return }
    if (!captcha) { message.warning('请完成人机验证'); return }
    try {
      await authApi.sendCode(email.trim(), captcha)
      setCodeSent(true)
      setCountdown(60)
      setCaptchaKey(k => k + 1)   // 票据已消耗（一次性），立即换新题供下次重发（Codex 06）
      message.success(`验证码已发送至 ${email.trim()}`)
    } catch (e) {
      message.error(e.message)
      setCaptchaKey(k => k + 1)   // 票据一次性，失败后换新题
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
    <Modal open={open} onCancel={onClose} title="忘记密码" footer={null} width={400} centered>
      <p style={{ fontSize: 13, color: 'var(--mute)', marginTop: 0 }}>
        输入注册时使用的邮箱或 UID，我们会把验证码发到账号绑定的邮箱
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <LabelInput
          label="邮箱地址或 UID" value={email}
          onChange={setEmail} autoComplete="username"
        />
        <CaptchaField onChange={setCaptcha} refreshKey={captchaKey} />
        <div>
          {/* 标签行：左标签右发码按钮（BirthTime 同款布局），OtpInput 居中收集 */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span className="font-caption">邮箱验证码</span>
            <Button size="small" type="link" onClick={sendCode} disabled={countdown > 0} style={{ padding: 0 }}>
              {countdown > 0 ? `重新发送（${countdown}s）` : codeSent ? '重发验证码' : '发送验证码'}
            </Button>
          </div>
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <OtpInput length={6} onChange={setCode} />
          </div>
        </div>
        <div>
          <LabelInput
            label="新密码" secret value={newPwd}
            onChange={setNewPwd} autoComplete="new-password"
          />
          {/* 密码规则不进标签，挪框下小字（碳碳定稿） */}
          <div className="font-caption" style={{ fontSize: 11, marginTop: 4 }}>至少 8 位，含字母 + 数字 + 符号</div>
        </div>
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
