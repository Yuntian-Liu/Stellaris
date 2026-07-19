/**
 * API 调用封装
 * 统一 fetch:自动注入 JWT token、401 拦截、错误处理
 */

const TOKEN_KEY = 'stellaris_token'

export function getToken() { return localStorage.getItem(TOKEN_KEY) }
export function setToken(t) { localStorage.setItem(TOKEN_KEY, t) }
export function clearToken() { localStorage.removeItem(TOKEN_KEY) }

/**
 * 统一请求封装
 * - 自动注入 Authorization: Bearer <token>
 * - 401:清 token + 派发 stellaris:unauthorized 事件(由 AuthContext/App 监听)
 * - !ok:抛 Error(detail)
 */
async function request(path, { method = 'GET', body, headers, isForm = false } = {}) {
  const token = getToken()
  const finalHeaders = { ...(headers || {}) }
  if (token) finalHeaders.Authorization = `Bearer ${token}`
  if (body && !isForm) finalHeaders['Content-Type'] = 'application/json'

  const res = await fetch(path, {
    method,
    headers: finalHeaders,
    body: body && !isForm ? JSON.stringify(body) : body,
  })

  if (res.status === 401) {
    clearToken()
    window.dispatchEvent(new CustomEvent('stellaris:unauthorized'))
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail || '登录已过期,请重新登录')
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail || `请求失败 (${res.status})`)
  }
  return res.json()
}

/* ═══ 任务接口(现有,改走 request,签名不变,调用方无需改)═══ */

export const submit = (payload) => request('/api/submit', { method: 'POST', body: payload })
export const upload = (formData) => request('/api/upload', { method: 'POST', body: formData, isForm: true })
export const getTask = (taskId) => request(`/api/task/${taskId}`)
export const exportMarkdown = (taskId) => request(`/api/export_md/${taskId}`, { method: 'POST' })
export const summarize = (taskId) => request(`/api/summarize/${taskId}`, { method: 'POST' })
export const estimate = (url) => request('/api/estimate', { method: 'POST', body: { url } })
export const cleanupTask = (taskId) => request(`/api/task/${taskId}`, { method: 'DELETE' })

// 下载是 <a> 直接触发,不走 fetch(后端 download 未加鉴权,无需 token)
export function getDownloadUrl(taskId, format) {
  return `/api/download/${taskId}/${format}`
}

/* ═══ Auth 接口 ═══ */

export const authApi = {
  checkEmail: (email) => request('/api/auth/check-email', { method: 'POST', body: { email } }),
  sendCode: (email, turnstileToken) => request('/api/auth/send-code', {
    method: 'POST',
    body: { email },
    headers: { 'cf-turnstile-response': turnstileToken || '' },
  }),
  loginCode: (email, code) => request('/api/auth/login-code', { method: 'POST', body: { email, code } }),
  register: (payload) => request('/api/auth/register', { method: 'POST', body: payload }),
  loginPassword: (email_or_uid, password) => request('/api/auth/login-password', { method: 'POST', body: { email_or_uid, password } }),
  getMe: () => request('/api/auth/me'),
  updateProfile: (payload) => request('/api/auth/profile', { method: 'PUT', body: payload }),
}

export default { submit, upload, getTask, getDownloadUrl, exportMarkdown, summarize, estimate, cleanupTask, authApi }
