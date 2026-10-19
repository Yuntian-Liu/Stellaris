/**
 * 数据自助导出弹窗（V1.6.1，迁移保障·临时功能——迁移结束后下线）
 *
 * 开启方式：事件总线（window 'stellaris:open-export'，与 open-guide 同例）
 * 或设置页入口。确认动作用 Bencho SlideConfirm（滑动 = 明确意图，防误点）。
 * 导出内容：账号资料 / 计费与流水 / 提取历史（含字幕全文）/ 文件柜 / 工单。
 * 恢复途径：工单提交存档 + 管理员人工审核（无自助导入，防伪造资损）。
 */
import { useEffect, useState } from 'react'
import { Modal, message } from 'antd'
import { getToken } from '../hooks/api'
import { clientLog } from '../utils/clientLog'
import { useAuth } from '../contexts/AuthContext'
import SlideConfirm from './bencho/SlideConfirm'

export const OPEN_EXPORT_EVENT = 'stellaris:open-export'

export default function DataExportModal() {
  const [open, setOpen] = useState(false)
  const { user } = useAuth()

  useEffect(() => {
    const on = () => setOpen(true)
    window.addEventListener(OPEN_EXPORT_EVENT, on)
    return () => window.removeEventListener(OPEN_EXPORT_EVENT, on)
  }, [])

  // SlideConfirm 的完成契约：Promise 解决 + 动画停留并行，两者皆成才 onDone
  const doExport = async () => {
    const res = await fetch('/api/export/mydata', {
      headers: { Authorization: `Bearer ${getToken()}` },
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.detail || `导出失败 (${res.status})`)
    }
    const data = await res.json()
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `stellaris-mydata-${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(a.href)
    clientLog.add('ui', `数据自助导出成功（历史 ${data.history?.length ?? 0} 条 / 文件柜 ${data.vault_files?.length ?? 0} 个）`)
  }

  return (
    <Modal
      open={open}
      onCancel={() => setOpen(false)}
      footer={null}
      width={420}
      centered
      title={<span className="font-display">导出我的数据</span>}
    >
      {/* 临时功能标注（迁移保障，非保常驻功能） */}
      <div style={{
        fontSize: 12, color: 'var(--mute)', lineHeight: 1.7,
        background: 'var(--accent-light)', borderRadius: 8,
        padding: '8px 12px', marginBottom: 14,
      }}>
        这是服务迁移期间限时开放的功能（迁移完成后下线）。存档用于不可抗力时的恢复凭证。
      </div>

      {user ? (
        <>
          <div className="font-body" style={{ fontSize: 13, color: 'var(--body)', lineHeight: 1.8, marginBottom: 8 }}>
            存档包含你的全部数据：
          </div>
          <ul style={{ fontSize: 13, color: 'var(--body)', lineHeight: 2, paddingLeft: 20, margin: '0 0 14px' }}>
            <li>账号资料与额度余额（分钟 / 引力波 / 量子波）</li>
            <li>账单流水与会员记录</li>
            <li>提取历史（含字幕、MD 笔记、内容概要全文）</li>
            <li>文件柜全部文件</li>
            <li>工单与回复记录</li>
          </ul>
          <div className="font-caption" style={{ fontSize: 12, lineHeight: 1.7, marginBottom: 18 }}>
            存档为 JSON 文件，请妥善保管。如需恢复：通过工单提交存档，我们审核后人工恢复。
          </div>
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <SlideConfirm
              label="滑动导出我的数据"
              doneLabel="已导出"
              onConfirm={doExport}
              onDone={() => {
                message.success('数据存档已导出，请妥善保存')
                clientLog.add('ui', '数据自助导出完成（滑动确认）')
                setOpen(false)
              }}
              onError={(e) => {
                clientLog.add('ui', `数据自助导出失败: ${e.message}`)
                message.error(e.message)
              }}
            />
          </div>
        </>
      ) : (
        <div style={{ textAlign: 'center', padding: '12px 0 4px', fontSize: 13, color: 'var(--mute)', lineHeight: 1.8 }}>
          导出需要登录账号——游客数据只保存在本浏览器，无需导出。
        </div>
      )}
    </Modal>
  )
}
