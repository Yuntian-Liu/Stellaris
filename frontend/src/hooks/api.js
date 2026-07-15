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

// 默认导出（方便 import api from './api'）
export default { submit, upload, getTask, getDownloadUrl }
