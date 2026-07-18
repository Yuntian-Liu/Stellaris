/**
 * API 调用封装
 * 统一处理后端接口的请求/响应
 */

const BASE_URL = ''  // Vite proxy 会把 /api 转发到后端

/**
 * 提交 B站链接任务
 */
export async function submit({ source, url, sessdata }) {
  const res = await fetch(`${BASE_URL}/api/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, url, sessdata }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail || `提交失败 (${res.status})`)
  }
  return res.json()
}

/**
 * 上传视频文件
 */
export async function upload(formData) {
  const res = await fetch(`${BASE_URL}/api/upload`, {
    method: 'POST',
    body: formData,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail || `上传失败 (${res.status})`)
  }
  return res.json()
}

/**
 * 查询任务状态
 */
export async function getTask(taskId) {
  const res = await fetch(`${BASE_URL}/api/task/${taskId}`)
  if (!res.ok) {
    throw new Error(`查询失败 (${res.status})`)
  }
  return res.json()
}

/**
 * 获取下载链接
 */
export function getDownloadUrl(taskId, format) {
  return `${BASE_URL}/api/download/${taskId}/${format}`
}

/**
 * 触发 Markdown 导出（增值功能，异步生成）
 * 返回最新任务状态（含 md_status）
 */
export async function exportMarkdown(taskId) {
  const res = await fetch(`${BASE_URL}/api/export_md/${taskId}`, { method: 'POST' })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail || `导出失败 (${res.status})`)
  }
  return res.json()
}

/**
 * 触发内容总结概要（增值功能，异步生成）
 * 返回最新任务状态（含 summary_status）
 */
export async function summarize(taskId) {
  const res = await fetch(`${BASE_URL}/api/summarize/${taskId}`, { method: 'POST' })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail || `总结生成失败 (${res.status})`)
  }
  return res.json()
}

/**
 * 提取前成本预估（只拉元数据，不下载）
 * 返回 { title, duration_sec, est_char_count, est_llm_tokens }
 */
export async function estimate(url) {
  const res = await fetch(`${BASE_URL}/api/estimate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail || `预估失败 (${res.status})`)
  }
  return res.json()
}

// 默认导出（方便 import api from './api'）
export default { submit, upload, getTask, getDownloadUrl, exportMarkdown, summarize, estimate }
