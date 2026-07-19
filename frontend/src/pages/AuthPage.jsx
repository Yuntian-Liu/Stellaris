/**
 * 登录/注册页 — step 状态机(完整)
 * 登录流:email → code → done
 * 注册流:email → code → avatar → profile → success → done
 * 新用户 code 步验码通过后(need_register)自动进注册流,无需用户选"登录/注册"
 */
import { useState, useCallback } from 'react'
import EmailStep from '../components/auth/EmailStep'
import CodeStep from '../components/auth/CodeStep'
import AvatarStep from '../components/auth/AvatarStep'
import ProfileStep from '../components/auth/ProfileStep'
import SuccessStep from '../components/auth/SuccessStep'
import { useAuth } from '../contexts/AuthContext'
import { authApi } from '../hooks/api'

export default function AuthPage({ onSuccess }) {
  const { login } = useAuth()
  const [step, setStep] = useState('email')
  const [flowData, setFlowData] = useState({})

  // EmailStep 回调:发码成功→进 code;密码登录成功→完成
  const handleEmailSuccess = useCallback((data) => {
    if (data.step === 'code') {
      setFlowData({ email: data.email, turnstileToken: data.turnstileToken })
      setStep('code')
    } else if (data.step === 'done') {
      login(data.token, data.user)
      onSuccess()
    }
  }, [login, onSuccess])

  // CodeStep 回调:res = {token, user, need_register},code 是验证码值(注册用)
  const handleCodeSuccess = useCallback((res, code) => {
    if (res.need_register) {
      setFlowData(d => ({ ...d, code }))
      setStep('avatar')
    } else {
      login(res.token, res.user)
      onSuccess()
    }
  }, [login, onSuccess])

  const handleAvatarSelect = useCallback((avatarSeed) => {
    setFlowData(d => ({ ...d, avatar_seed: avatarSeed }))
    setStep('profile')
  }, [])

  // ProfileStep 提交 → 调 register
  const handleProfileSubmit = useCallback(async ({ nickname, password, inviteCode }) => {
    const res = await authApi.register({
      email: flowData.email,
      code: flowData.code,
      nickname,
      password,
      avatar_seed: flowData.avatar_seed,
      invite_code: inviteCode,
    })
    login(res.token, res.user)
    setFlowData(d => ({ ...d, registeredUser: res.user }))
    setStep('success')
  }, [flowData, login])

  return (
    <>
      {step === 'email' && <EmailStep onSuccess={handleEmailSuccess} />}

      {step === 'code' && (
        <CodeStep
          email={flowData.email}
          turnstileToken={flowData.turnstileToken}
          onBack={() => setStep('email')}
          onSuccess={handleCodeSuccess}
        />
      )}

      {step === 'avatar' && (
        <AvatarStep onBack={() => setStep('code')} onSelect={handleAvatarSelect} />
      )}

      {step === 'profile' && (
        <ProfileStep
          avatarSeed={flowData.avatar_seed}
          onBack={() => setStep('avatar')}
          onSubmit={handleProfileSubmit}
        />
      )}

      {step === 'success' && flowData.registeredUser && (
        <SuccessStep user={flowData.registeredUser} onDone={onSuccess} />
      )}
    </>
  )
}
