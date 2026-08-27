/**
 * 邮箱步 — 邮箱输入 + 验证码/密码双 tab + 图形验证码（V1.2.2 自托管）+ 协议勾选
 * 验证码 tab:发码 → 进 CodeStep
 * 密码 tab:直接登录(邮箱或 UID)
 */
import { useState } from 'react'
import { Input, Button, Segmented, Checkbox, Tooltip } from 'antd'
import { authApi } from '../../hooks/api'
import AgreementModal from '../AgreementModal'
import ForgotPasswordModal from './ForgotPasswordModal'
import CaptchaField from './CaptchaField'


export default function EmailStep({ onSuccess }) {
  const [email, setEmail] = useState('')
  const [mode, setMode] = useState('code')  // 'code' | 'password'
  const [password, setPassword] = useState('')
  const [agreed, setAgreed] = useState(false)
  const [captcha, setCaptcha] = useState(null)       // {captchaId, answer} | null
  const [captchaKey, setCaptchaKey] = useState(0)    // 提交失败后 ++，强制换新题（票据一次性）
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [agreementOpen, setAgreementOpen] = useState(false)
  const [agreementType, setAgreementType] = useState('agreement')
  const [forgotOpen, setForgotOpen] = useState(false)

  const openAgreement = (type) => {
    setAgreementType(type)
    setAgreementOpen(true)
  }

  const handleSendCode = async () => {
    setError('')
    if (!email) { setError('请输入邮箱地址'); return }
    if (!agreed) { setError('请先阅读并同意用户协议与隐私政策'); return }
    if (!captcha) { setError('请完成人机验证'); return }
    setLoading(true)
    try {
      await authApi.sendCode(email, captcha)
      onSuccess({ step: 'code', email, mode })
    } catch (e) {
      setError(e.message)
      setCaptchaKey(k => k + 1)   // 票据已消耗（一次性），换新题
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
      const res = await authApi.loginPassword(email, password, captcha)
      onSuccess({ step: 'done', token: res.token, user: res.user })
    } catch (e) {
      setError(e.message)
      setCaptchaKey(k => k + 1)
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
        placeholder="邮箱地址或 UID"
        value={email}
        onChange={e => setEmail(e.target.value)}
        style={{ marginBottom: 12 }}
      />

      {mode === 'password' && (
        <>
          <Input.Password
            size="large"
            placeholder="密码"
            value={password}
            onChange={e => setPassword(e.target.value)}
            style={{ marginBottom: 4 }}
          />
          <div style={{ textAlign: 'right', marginBottom: 12 }}>
            <a style={{ fontSize: 12 }} onClick={() => setForgotOpen(true)}>
              忘记密码？
            </a>
          </div>
        </>
      )}

      <CaptchaField onChange={setCaptcha} refreshKey={captchaKey} />

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
          : !captcha ? '请完成人机验证'
          : ''
        }
      >
        <span style={{ display: 'block' }}>
          <Button
            type="primary"
            size="large"
            block
            disabled={!agreed || !captcha}
            loading={loading}
            onClick={mode === 'code' ? handleSendCode : handlePasswordLogin}
          >
            {mode === 'code' ? '发送验证码' : '登录'}
          </Button>
        </span>
      </Tooltip>

      <AgreementModal open={agreementOpen} type={agreementType} onClose={() => setAgreementOpen(false)} />
      <ForgotPasswordModal open={forgotOpen} email={email} onClose={() => setForgotOpen(false)} />
    </div>
  )
}
