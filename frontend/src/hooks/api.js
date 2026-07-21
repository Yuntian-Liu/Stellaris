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
export const estimate = (url, sessdata) =>
  request('/api/estimate', { method: 'POST', body: { url, sessdata: sessdata || null } })
export const chat = (taskId, message, history) =>
  request(`/api/chat/${taskId}`, { method: 'POST', body: { message, history } })
export const getChat = (taskId) => request(`/api/chat/${taskId}`)

/**
 * AI 解读对话（SSE 流式版）
 * onDelta(text) 逐段回调正文；onDone(usage) 结束回调 token 用量；
 * 出错抛 Error（含流中途的 error 事件）
 */
export async function chatStream(taskId, message, history, { onDelta, onDone } = {}) {
  const token = getToken()
  const res = await fetch(`/api/chat/${taskId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ message, history }),
  })

  if (res.status === 401) {
    clearToken()
    window.dispatchEvent(new CustomEvent('stellaris:unauthorized'))
    throw new Error('登录已过期,请重新登录')
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail || `请求失败 (${res.status})`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    // SSE 按 \n\n 切事件，data: 前缀取 JSON
    let idx
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 2)
      if (!raw.startsWith('data:')) continue
      let evt
      try { evt = JSON.parse(raw.slice(5)) } catch { continue }
      if (evt.type === 'delta') onDelta?.(evt.text)
      else if (evt.type === 'done') onDone?.(evt.usage, evt.charged)
      else if (evt.type === 'error') throw new Error(evt.message || 'AI 解读失败')
    }
  }
}
export const cleanupTask = (taskId) => request(`/api/task/${taskId}`, { method: 'DELETE' })

// 下载是 <a> 直接触发,不走 fetch；R1 后下载需鉴权,<a href> 无法加 header,
// 故登录态把 token 拼到 query（匿名任务 owner_uid=None 放行,无 token 也 200）
export function getDownloadUrl(taskId, format) {
  const token = getToken()
  const base = `/api/download/${taskId}/${format}`
  return token ? `${base}?token=${encodeURIComponent(token)}` : base
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
  changePassword: (old_password, new_password) =>
    request('/api/auth/change-password', { method: 'PUT', body: { old_password, new_password } }),
  resetPassword: (email, code, new_password) =>
    request('/api/auth/reset-password', { method: 'POST', body: { email, code, new_password } }),
}

export const getStats = () => request('/api/user/stats')
export const getHistory = () => request('/api/history')

export const getBilling = () => request('/api/billing/summary')
export const exchange = (direction, count) =>
  request('/api/billing/exchange', { method: 'POST', body: { direction, count } })
export const getLedger = (page = 1, size = 20, currency) =>
  request(`/api/billing/ledger?page=${page}&size=${size}${currency ? `&currency=${currency}` : ''}`)
export const redeemPreview = (code) =>
  request(`/api/redeem/preview?code=${encodeURIComponent(code)}`)
export const redeem = (code) =>
  request('/api/redeem', { method: 'POST', body: { code } })
export const getMembershipHistory = () => request('/api/membership/history')

/* ═══ 管理看板接口（V0.9.0，后端 get_admin_user 守卫：非 admin 403）═══ */

export const adminApi = {
  overview: () => request('/api/admin/overview'),
  searchUsers: (query) => request(`/api/admin/users?query=${encodeURIComponent(query)}`),
  adjustBalance: (payload) => request('/api/admin/user/adjust', { method: 'POST', body: payload }),
  userUsage: (uid) => request(`/api/admin/user/${uid}/usage`),
  setTier: (payload) => request('/api/admin/user/tier', { method: 'POST', body: payload }),
  listCodes: () => request('/api/admin/codes'),
  createCodes: (payload) => request('/api/admin/codes', { method: 'POST', body: payload }),
  listOrders: (status) => request(`/api/admin/orders${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  fulfillOrder: (outTradeNo, payload) =>
    request(`/api/admin/orders/${encodeURIComponent(outTradeNo)}/fulfill`, { method: 'POST', body: payload }),
  recheckOrder: (outTradeNo) =>
    request(`/api/admin/orders/${encodeURIComponent(outTradeNo)}/recheck`, { method: 'POST' }),
  trends: (days = 30) => request(`/api/admin/trends?days=${days}`),
  pinStatus: () => request('/api/admin/pin/status'),
  setPin: (pin) => request('/api/admin/pin/set', { method: 'POST', body: { pin } }),
}

export default { submit, upload, getTask, getDownloadUrl, exportMarkdown, summarize, estimate, chat, chatStream, getChat, getStats, getBilling, getHistory, exchange, getLedger, redeemPreview, redeem, getMembershipHistory, cleanupTask, authApi, adminApi }
