/**
 * 验证码步 — 6 格输入(自动跳焦 / 粘贴整体填入 / 60 秒倒计时重发)
 */
import { useState, useEffect, useRef } from 'react'
import { Button } from 'antd'
import { authApi } from '../../hooks/api'

export default function CodeStep({ email, turnstileToken, onBack, onSuccess }) {
  const [code, setCode] = useState(['', '', '', '', '', ''])
  const [countdown, setCountdown] = useState(60)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const inputsRef = useRef([])

  // 60 秒倒计时
  useEffect(() => {
    if (countdown <= 0) return
    const t = setTimeout(() => setCountdown(c => c - 1), 1000)
    return () => clearTimeout(t)
  }, [countdown])

  // 自动聚焦第一格
  useEffect(() => { inputsRef.current[0]?.focus() }, [])

  const handleChange = (i, v) => {
    const ch = v.replace(/\D/g, '').slice(-1)
    setCode(prev => {
      const next = [...prev]
      next[i] = ch
      return next
    })
    if (ch && i < 5) inputsRef.current[i + 1]?.focus()
  }

  const handleKey = (i, e) => {
    // 空格按 Backspace 跳回上一格
    if (e.key === 'Backspace' && !code[i] && i > 0) {
      inputsRef.current[i - 1]?.focus()
    }
  }

  const handlePaste = (e) => {
    e.preventDefault()
    const text = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6).split('')
    if (!text.length) return
    const next = ['', '', '', '', '', '']
    text.forEach((ch, i) => { next[i] = ch })
    setCode(next)
    inputsRef.current[Math.min(text.length, 5)]?.focus()
  }

  const handleResend = async () => {
    setError('')
    try {
      await authApi.sendCode(email, turnstileToken)
      setCountdown(60)
    } catch (e) {
      setError(e.message)
    }
  }

  const handleSubmit = async () => {
    const full = code.join('')
    if (full.length !== 6) { setError('请输入完整 6 位验证码'); return }
    setLoading(true); setError('')
    try {
      const res = await authApi.loginCode(email, full)
      onSuccess(res, full)  // 注册流需带上验证码值(register 时二次校验)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="page-enter" style={{ maxWidth: 380, margin: '0 auto' }}>
      <h2 className="font-display font-display-sm" style={{ marginBottom: 8 }}>输入验证码</h2>
      <p className="font-caption" style={{ marginBottom: 24 }}>
        验证码已发送至 <strong style={{ color: 'var(--ink)' }}>{email}</strong>
      </p>

      <div style={{ display: 'flex', gap: 10, marginBottom: 16, justifyContent: 'center' }} onPaste={handlePaste}>
        {code.map((c, i) => (
          <input
            key={i}
            ref={el => inputsRef.current[i] = el}
            value={c}
            onChange={e => handleChange(i, e.target.value)}
            onKeyDown={e => handleKey(i, e)}
            maxLength={1}
            inputMode="numeric"
            style={{
              width: 48, height: 56, textAlign: 'center', fontSize: 22, fontWeight: 600,
              border: '1px solid var(--hairline)', borderRadius: 8,
              outline: 'none', fontFamily: "'JetBrains Mono', monospace",
              color: 'var(--ink)',
            }}
          />
        ))}
      </div>

      {error && <div style={{ color: 'var(--error)', fontSize: 13, marginBottom: 12, textAlign: 'center' }}>{error}</div>}

      <div style={{ marginBottom: 20, textAlign: 'center' }}>
        {countdown > 0 ? (
          <span className="font-caption">{countdown} 秒后可重新发送</span>
        ) : (
          <Button type="link" style={{ padding: 0 }} onClick={handleResend}>重新发送验证码</Button>
        )}
      </div>

      <div style={{ display: 'flex', gap: 12 }}>
        <Button onClick={onBack}>返回</Button>
        <Button type="primary" loading={loading} onClick={handleSubmit} style={{ flex: 1 }}>
          验证
        </Button>
      </div>
    </div>
  )
}
