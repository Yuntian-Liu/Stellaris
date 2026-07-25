/**
 * 匿名提取历史（localStorage 本地记忆）
 * 匿名任务服务端不建 task_records 行（1h 过期即清），历史只能记在浏览器。
 * 数据不出本机，无隐私负担；登录用户走服务端历史，不用这个。
 */
const KEY = 'stellaris:anon-history'
const MAX_ENTRIES = 10

export function readAnonHistory() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY))
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

export function pushAnonHistory({ task_id, title, platform }) {
  if (!task_id) return
  const list = readAnonHistory().filter(r => r.task_id !== task_id)
  list.unshift({
    task_id,
    title: title || '未命名视频',
    platform: platform || '',
    created_at: new Date().toISOString(),
  })
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_ENTRIES)))
  } catch { /* 隐私模式写不进去就算了，历史不是核心功能 */ }
}

export function removeAnonHistory(taskId) {
  try {
    localStorage.setItem(KEY, JSON.stringify(readAnonHistory().filter(r => r.task_id !== taskId)))
  } catch { /* 同上，忽略即可 */ }
}
