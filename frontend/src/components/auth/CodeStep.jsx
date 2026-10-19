/**
 * 验证码步 — OtpInput 六格一体（Bencho "One-time code"，输满自动提交：
 * 通过=格子融合成 ✓ 已验证 胶囊，失败=抖动排空）
 * V1.2.2：重发需现场完成图形验证码（票据一次性，不可复用首次的）
 */
import { useState, useEffect } from 'react'
import { Button } from 'antd'
import { authApi } from '../../hooks/api'
import { clientLog } from '../../utils/clientLog'
import CaptchaField from './CaptchaField'
import OtpInput from '../bencho/OtpInput'

export default function CodeStep({ email, onBack, onSuccess }) {
  const [countdown, setCountdown] = useState(60)
  const [error, setError] = useState('')
  const [captcha, setCaptcha] = useState(null)         // 重发用图形验证码
  const [captchaKey, setCaptchaKey] = useState(0)
  const [showCaptcha, setShowCaptcha] = useState(false)

  // 60 秒倒计时
  useEffect(() => {
    if (countdown <= 0) return
    const t = setTimeout(() => setCountdown(c => c - 1), 1000)
    return () => clearTimeout(t)
  }, [countdown])

  const handleResend = async () => {
    setError('')
    // V1.2.2：图形验证码一次性，重发必须现场完成新挑战
    if (!showCaptcha) { setShowCaptcha(true); return }
    if (!captcha) { setError('请完成人机验证'); return }
    try {
      await authApi.sendCode(email, captcha)
      setCountdown(60)
      setShowCaptcha(false)
    } catch (e) {
      setError(e.message)
      setCaptchaKey(k => k + 1)   // 票据已消耗，换新题
    }
  }

  // 输满 6 位自动提交（OtpInput onComplete；true=融合动画，false=抖动排空）
  const verify = async (full) => {
    setError('')
    try {
      const res = await authApi.loginCode(email, full)
      clientLog.add('auth', '验证码校验通过（输满自动提交）')   // 不记验证码本身
      // 先让组件播完「融合成 ✓ 已验证」，停一拍再切步（BirthTime 同款时序）
      setTimeout(() => onSuccess(res, full), 750)  // 注册流需带上验证码值(register 时二次校验)
      return true
    } catch (e) {
      clientLog.add('auth', `验证码校验失败: ${e.message}`)
      setError(e.message)
      return false
    }
  }

  return (
    <div className="page-enter" style={{ maxWidth: 380, margin: '0 auto' }}>
      <h2 className="font-display font-display-sm" style={{ marginBottom: 8 }}>输入验证码</h2>
      <p className="font-caption" style={{ marginBottom: 24 }}>
        {/* UID 输入只提示"绑定邮箱"（防枚举，后端不回传邮箱）；邮箱输入回显原文 */}
        验证码已发送至 <strong style={{ color: 'var(--ink)' }}>
          {/^\d+$/.test(email) ? '该账号绑定的邮箱' : email}
        </strong>
      </p>

      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
        <OtpInput length={6} onComplete={verify} />
      </div>

      {error && <div style={{ color: 'var(--error)', fontSize: 13, marginBottom: 12, textAlign: 'center' }}>{error}</div>}

      <div style={{ marginBottom: 20, textAlign: 'center' }}>
        {countdown > 0 ? (
          <span className="font-caption">{countdown} 秒后可重新发送</span>
        ) : (
          <>
            {showCaptcha && (
              <div style={{ marginBottom: 8, textAlign: 'left' }}>
                <CaptchaField onChange={setCaptcha} refreshKey={captchaKey} />
              </div>
            )}
            <Button type="link" style={{ padding: 0 }} onClick={handleResend}>
              {showCaptcha ? '完成验证并重发' : '重新发送验证码'}
            </Button>
          </>
        )}
      </div>

      <Button onClick={onBack} block>返回</Button>
    </div>
  )
}
