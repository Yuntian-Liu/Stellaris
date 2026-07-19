/**
 * 邮箱步 — 邮箱输入 + 验证码/密码双 tab + Turnstile + 协议勾选
 * 验证码 tab:发码 → 进 CodeStep
 * 密码 tab:直接登录(邮箱或 UID)
 */
import { useState, useEffect, useRef } from 'react'
import { Input, Button, Segmented, Checkbox, Tooltip } from 'antd'
import { authApi } from '../../hooks/api'
import AgreementModal from '../AgreementModal'

export default function EmailStep({ onSuccess }) {
  const [email, setEmail] = useState('')
  const [mode, setMode] = useState('code')  // 'code' | 'password'
  const [password, setPassword] = useState('')
  const [agreed, setAgreed] = useState(false)
  const [turnstileToken, setTurnstileToken] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [agreementOpen, setAgreementOpen] = useState(false)
  const [agreementType, setAgreementType] = useState('agreement')
  const turnstileRef = useRef(null)
  const widgetId = useRef(null)

  const [pubConfig, setPubConfig] = useState(null)  // {turnstile_site_key, is_prod}

  // 启动拿公开配置(site key 运行时拿,避免 Vite build-time env 依赖)
  useEffect(() => {
    fetch('/api/config').then(r => r.json()).then(c => {
      setPubConfig(c)
      if (!c.is_prod) setTurnstileToken('dev-bypass')  // 开发模式 bypass
    }).catch(() => setTurnstileToken('dev-bypass'))
  }, [])

  // 生产期渲染 Turnstile widget(轮询 window.turnstile 直到脚本就绪)
  useEffect(() => {
    if (!pubConfig?.is_prod) return
    const siteKey = pubConfig.turnstile_site_key
    if (!siteKey) return
    let cancelled = false
    const tryRender = () => {
      if (cancelled) return
      if (window.turnstile && turnstileRef.current && widgetId.current === null) {
        widgetId.current = window.turnstile.render(turnstileRef.current, {
          sitekey: siteKey,
          callback: (t) => setTurnstileToken(t),
          'expired-callback': () => setTurnstileToken(null),
          'error-callback': () => setTurnstileToken(null),
        })
      } else if (!window.turnstile) {
        setTimeout(tryRender, 200)
      }
    }
    tryRender()
    return () => { cancelled = true }
  }, [pubConfig])

  const openAgreement = (type) => {
    setAgreementType(type)
    setAgreementOpen(true)
  }

  const handleSendCode = async () => {
    setError('')
    if (!email) { setError('请输入邮箱地址'); return }
    if (!agreed) { setError('请先阅读并同意用户协议与隐私政策'); return }
    if (!turnstileToken) { setError('请完成人机验证'); return }
    setLoading(true)
    try {
      await authApi.sendCode(email, turnstileToken)
      onSuccess({ step: 'code', email, turnstileToken, mode })
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const handlePasswordLogin = async () => {
    setError('')
    if (!email) { setError('请输入邮箱或 UID'); return }
    if (!password) { setError('请输入密码'); return }
    if (!agreed) { setError('请先阅读并同意用户协议与隐私政策'); return }
    setLoading(true)
    try {
      const res = await authApi.loginPassword(email, password)
      onSuccess({ step: 'done', token: res.token, user: res.user })
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="page-enter" style={{ maxWidth: 380, margin: '0 auto' }}>
      <h1 className="font-display font-display-md" style={{ textAlign: 'center', marginBottom: 6 }}>
        登录 Stellaris
      </h1>
      <p className="font-caption" style={{ textAlign: 'center', marginBottom: 28 }}>
        把声音变成你能读到的文字
      </p>

      <Segmented
        block
        value={mode}
        onChange={setMode}
        options={[
          { label: '验证码登录', value: 'code' },
          { label: '密码登录', value: 'password' },
        ]}
        style={{ marginBottom: 20 }}
      />

      <Input
        size="large"
        placeholder="邮箱地址"
        value={email}
        onChange={e => setEmail(e.target.value)}
        style={{ marginBottom: 12 }}
      />

      {mode === 'password' && (
        <Input.Password
          size="large"
          placeholder="密码"
          value={password}
          onChange={e => setPassword(e.target.value)}
          style={{ marginBottom: 12 }}
        />
      )}

      {mode === 'code' && pubConfig?.is_prod && (
        <div ref={turnstileRef} style={{ marginBottom: 12, minHeight: 65 }} />
      )}

      <div style={{ marginBottom: 16, fontSize: 13, lineHeight: 1.6 }}>
        <Checkbox checked={agreed} onChange={e => setAgreed(e.target.checked)}>
          我已阅读并同意
        </Checkbox>
        <a onClick={() => openAgreement('agreement')} style={{ marginLeft: 4 }}>《用户协议》</a>
        <span> 和 </span>
        <a onClick={() => openAgreement('privacy')}>《隐私政策》</a>
      </div>

      {error && <div style={{ color: 'var(--error)', fontSize: 13, marginBottom: 12 }}>{error}</div>}

      <Tooltip
        title={
          !agreed ? '请先阅读并同意用户协议与隐私政策'
          : !turnstileToken ? '请完成人机验证'
          : ''
        }
      >
        <span style={{ display: 'block' }}>
          <Button
            type="primary"
            size="large"
            block
            disabled={!agreed || !turnstileToken}
            loading={loading}
            onClick={mode === 'code' ? handleSendCode : handlePasswordLogin}
          >
            {mode === 'code' ? '发送验证码' : '登录'}
          </Button>
        </span>
      </Tooltip>

      <AgreementModal open={agreementOpen} type={agreementType} onClose={() => setAgreementOpen(false)} />
    </div>
  )
}
