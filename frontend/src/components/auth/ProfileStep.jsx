/**
 * 资料步 — 昵称 + 密码(两次 + 实时强度) + 邀请码(选填)
 * 密码规则与后端 validate_password_strength 对齐:≥8 位 + 字母 + 数字 + 符号
 */
import { useState } from 'react'
import { Button } from 'antd'
import { avatarUrl } from '../../utils/avatar'
import LabelInput from '../bencho/LabelInput'

// 符号集与后端 utils.py _PASSWORD_SYMBOLS 完全一致
const SYMBOLS = '!@#$%^&*()-_=+[]{}|;:,.<>?/'

const RULES = [
  { key: 'len', label: '至少 8 位', test: p => p.length >= 8 },
  { key: 'letter', label: '含字母', test: p => /[A-Za-z]/.test(p) },
  { key: 'digit', label: '含数字', test: p => /\d/.test(p) },
  { key: 'symbol', label: '含符号', test: p => [...p].some(c => SYMBOLS.includes(c)) },
]

const AVATAR_STYLE = 'micah'

export default function ProfileStep({ avatarSeed, onSubmit, onBack }) {
  const [nickname, setNickname] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const checks = RULES.map(r => ({ ...r, pass: r.test(password) }))
  const allPass = checks.every(c => c.pass)

  const handleSubmit = async () => {
    setError('')
    if (!nickname.trim()) { setError('请输入昵称'); return }
    if (!allPass) { setError('密码不符合要求'); return }
    if (password !== confirm) { setError('两次输入的密码不一致'); return }
    setLoading(true)
    try {
      await onSubmit({
        nickname: nickname.trim(),
        password,
        inviteCode: inviteCode.trim() || null,
      })
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="page-enter" style={{ maxWidth: 380, margin: '0 auto' }}>
      <h2 className="font-display font-display-sm" style={{ marginBottom: 8 }}>完善资料</h2>
      <p className="font-caption" style={{ marginBottom: 20 }}>设置昵称与密码,完成注册</p>

      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20,
        padding: 12, background: 'var(--surface-1)',
        border: '1px solid var(--hairline)', borderRadius: 12,
      }}>
        <img
          src={avatarUrl(avatarSeed)}
          alt=""
          style={{ width: 48, height: 48, borderRadius: '50%', background: 'white' }}
        />
        <span className="font-body-strong">{nickname || '你的昵称'}</span>
      </div>

      <div style={{ marginBottom: 12 }}>
        <LabelInput label="昵称" value={nickname} onChange={setNickname} autoComplete="nickname" />
      </div>

      <LabelInput
        label="设置密码" secret value={password}
        onChange={setPassword} autoComplete="new-password"
      />
      {/* 实时强度提示（密码规则由 chips 承担，不进标签） */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8, marginBottom: 12 }}>
        {checks.map(c => (
          <span key={c.key} style={{
            fontSize: 11, padding: '2px 8px', borderRadius: 10,
            background: c.pass ? 'var(--success-bg)' : 'var(--surface-2)',
            color: c.pass ? 'var(--success)' : 'var(--mute)',
            transition: 'all 0.15s ease',
          }}>
            {c.pass ? '✓ ' : ''}{c.label}
          </span>
        ))}
      </div>

      <div style={{ marginBottom: 12 }}>
        <LabelInput
          label="确认密码" secret value={confirm}
          onChange={setConfirm} autoComplete="new-password"
        />
      </div>

      <div style={{ marginBottom: 12 }}>
        <LabelInput
          label="邀请码（选填）" value={inviteCode}
          onChange={setInviteCode} autoComplete="off"
        />
      </div>

      {error && <div style={{ color: 'var(--error)', fontSize: 13, marginBottom: 12 }}>{error}</div>}

      <div style={{ display: 'flex', gap: 12 }}>
        <Button onClick={onBack}>返回</Button>
        <Button type="primary" size="large" loading={loading} onClick={handleSubmit} style={{ flex: 1 }}>
          注册
        </Button>
      </div>
    </div>
  )
}
