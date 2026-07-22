/**
 * 提交工单弹窗（V0.9.4）
 * 分类切换：Bug 反馈 / 功能建议 / 其他
 * - Bug/其他：标题 + 发生时间 + 复现次数 + 详细描述 + 联系方式（选填）+ 强制附日志
 * - 建议：标题 + 内容 + 联系方式（选填）+ 日志可选勾
 * 提交成功 → 弹窗内切换为成功态（勾 + 主标题 + 说明）
 */
import { useState } from 'react'
import { Modal, Input, Select, Checkbox, Button, Radio, DatePicker, message } from 'antd'
import { CheckCircleOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { ticketApi } from '../hooks/api'
import { clientLog } from '../utils/clientLog'

const { TextArea } = Input

const REPRO_OPTIONS = [
  { value: '仅 1 次', label: '仅 1 次' },
  { value: '2-5 次', label: '2-5 次' },
  { value: '多次（5 次以上）', label: '多次（5 次以上）' },
  { value: '每次都复现', label: '每次都复现' },
]

const LOG_HINT = (
  <div style={{
    fontSize: 12, color: 'var(--body)', lineHeight: 1.7,
    background: 'var(--surface-2)', padding: '10px 12px',
    borderRadius: 'var(--r-input)', marginTop: 4,
  }}>
    本次反馈将提交诊断日志协助排查。
    日志仅含应用版本、最近任务状态记录与错误信息，
    <strong style={{ color: 'var(--ink)' }}>不含</strong>密码、音视频内容、字幕文本及个人联系方式。
  </div>
)

export default function TicketSubmitModal({ open, onClose, onSubmitted }) {
  const [category, setCategory] = useState('bug')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [occurAt, setOccurAt] = useState(null)   // dayjs 对象（DatePicker）
  const [repro, setRepro] = useState(undefined)
  const [contact, setContact] = useState('')
  const [attachLog, setAttachLog] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState(false)

  const isBugLike = category !== 'suggestion'

  const reset = () => {
    setCategory('bug'); setTitle(''); setDescription('')
    setOccurAt(null); setRepro(undefined); setContact('')
    setAttachLog(false); setSubmitting(false); setSuccess(false)
  }

  const handleClose = () => { reset(); onClose() }

  const handleSubmit = async () => {
    if (!title.trim()) { message.warning('请填写标题'); return }
    if (!description.trim()) { message.warning(`请填写${isBugLike ? '详细描述' : '内容'}`); return }
    if (isBugLike && !occurAt) { message.warning('请选择问题发生时间'); return }
    if (isBugLike && !repro) { message.warning('请选择复现次数'); return }

    setSubmitting(true)
    try {
      await ticketApi.create({
        title: title.trim(),
        category,
        description: description.trim(),
        occur_at: isBugLike ? occurAt.format('YYYY-MM-DD HH:mm') : null,
        repro_steps: isBugLike ? repro : null,
        contact: contact.trim() || null,
        attach_log: !isBugLike ? attachLog : false,   // bug 类后端强制抓，不传 attach_log
        client_events: clientLog.dump(),   // V0.10.1：附带前端操作日志
      })
      setSuccess(true)
    } catch (e) {
      message.error(e.message || '提交失败')
    } finally {
      setSubmitting(false)
    }
  }

  // ── 成功态 ──
  if (success) {
    return (
      <Modal open={open} onCancel={handleClose} footer={null} width={420} centered destroyOnClose>
        <div style={{ textAlign: 'center', padding: '20px 8px 12px' }}>
          <CheckCircleOutlined style={{ fontSize: 48, color: 'var(--success, #16a34a)', marginBottom: 16 }} />
          <div className="font-display font-display-sm" style={{ marginBottom: 8 }}>提交成功</div>
          <div style={{ fontSize: 13, color: 'var(--mute)', lineHeight: 1.7, marginBottom: 24 }}>
            我们会在工单中回复你，<br />请留意反馈页面的未读提示
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            <Button onClick={handleClose}>关闭</Button>
            <Button type="primary" onClick={() => { reset(); onSubmitted?.() }}>
              查看我的工单
            </Button>
          </div>
        </div>
      </Modal>
    )
  }

  return (
    <Modal open={open} onCancel={handleClose} footer={null} width={460} centered destroyOnClose
      title={<span className="font-display">提交工单</span>}
      styles={{ body: { height: 460, overflowY: 'auto' } }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 0' }}>
        <Radio.Group value={category} onChange={(e) => setCategory(e.target.value)} buttonStyle="solid" size="small">
          <Radio.Button value="bug">Bug 反馈</Radio.Button>
          <Radio.Button value="suggestion">功能建议</Radio.Button>
          <Radio.Button value="other">其他</Radio.Button>
        </Radio.Group>

        <Input placeholder="标题（一句话概括）" value={title} maxLength={100}
          onChange={(e) => setTitle(e.target.value)} />

        {isBugLike && (
          <>
            <DatePicker placeholder="选择问题发生时间" value={occurAt}
              onChange={setOccurAt} showTime={{ format: 'HH:mm' }}
              format="YYYY-MM-DD HH:mm" style={{ width: '100%' }} />
            <Select placeholder="复现次数" value={repro} options={REPRO_OPTIONS}
              onChange={setRepro} style={{ width: '100%' }} />
          </>
        )}

        <TextArea
          rows={3}
          value={description}
          maxLength={2000}
          placeholder={isBugLike
            ? '详细描述：进行了什么操作、期望结果、实际发生了什么'
            : '描述你希望增加的功能，以及它能解决什么问题'}
          onChange={(e) => setDescription(e.target.value)}
        />

        <Input placeholder="联系方式（选填）：QQ / 邮箱，留空则回复在工单中显示"
          value={contact} maxLength={64}
          onChange={(e) => setContact(e.target.value)} />

        {isBugLike ? (
          <>
            <div className="font-caption" style={{ marginTop: 4 }}>诊断日志（自动提交）</div>
            {LOG_HINT}
          </>
        ) : (
          <>
            <Checkbox checked={attachLog} onChange={(e) => setAttachLog(e.target.checked)}
              style={{ marginTop: 4 }}>
              附诊断日志（帮助了解使用环境）
            </Checkbox>
            {attachLog && LOG_HINT}
          </>
        )}

        <Button type="primary" block loading={submitting} onClick={handleSubmit}
          style={{ marginTop: 8 }}>
          提交
        </Button>
      </div>
    </Modal>
  )
}
