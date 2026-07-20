/**
 * 全局登录态 — AuthContext
 * user / loading / login(token,user) / logout
 * 启动时拉 /api/auth/me 验 token;监听 stellaris:unauthorized 自动登出
 */
import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { authApi, getToken, setToken, clearToken } from '../hooks/api'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  // 启动时验 token:有 token 就拉 me,失败则清 token
  useEffect(() => {
    const token = getToken()
    if (!token) { setLoading(false); return }
    authApi.getMe()
      .then(u => setUser(u))
      .catch(() => clearToken())
      .finally(() => setLoading(false))
  }, [])

  // 监听 401 事件(request 里派发)→ 清登录态
  useEffect(() => {
    const handler = () => { clearToken(); setUser(null) }
    window.addEventListener('stellaris:unauthorized', handler)
    return () => window.removeEventListener('stellaris:unauthorized', handler)
  }, [])

  const login = useCallback((token, u) => {
    setToken(token)
    setUser(u)
  }, [])

  const logout = useCallback(() => {
    clearToken()
    setUser(null)
  }, [])

  // 资料修改后重新拉取当前用户（昵称/头像即时生效）
  const refresh = useCallback(() => {
    return authApi.getMe().then(u => setUser(u)).catch(() => {})
  }, [])

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
