/**
 * 前端操作日志（V0.10.1）— 浏览器端事件环形缓冲
 * 记录用户交互（页面切换、按钮点击、API 调用、错误），提交工单/导诊断时附带，
 * 帮助排查"点了什么、走过哪些页面"这类交互问题（服务端日志看不到）。
 * 纯内存，max 200 条（≈25KB），零平时开销，刷新即清空。
 */

const MAX = 200
const buffer = []

function ts() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function add(type, detail) {
  buffer.push({ ts: ts(), type, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) })
  if (buffer.length > MAX) buffer.shift()
}

function dump() {
  return [...buffer]
}

// ===== 全局错误捕获（生产排查刚需：白屏/组件崩溃的唯一线索）=====
// 模块加载即挂载，只挂一次；崩了也要记进缓冲，工单/诊断导出时看得到
if (typeof window !== 'undefined') {
  // JS 运行时异常（未捕获的同步错误 + 资源加载错误）
  window.addEventListener('error', (e) => {
    const msg = e.error?.stack || e.message || '未知错误'
    add('error', `${e.filename || ''}:${e.lineno || ''} ${msg}`.slice(0, 500))
  })
  // Promise 未处理的 rejection（async 错误、fetch 失败等）
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason?.message || e.reason?.stack || String(e.reason || '')
    add('error', `Promise ${reason}`.slice(0, 500))
  })
}

export const clientLog = { add, dump }
