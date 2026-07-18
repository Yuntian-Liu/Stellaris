/**
 * 页面 1：输入页 — Starlight 设计系统
 *
 * 两段式提交流程（成本透明化）：
 *   A. 输入链接 → 点击「开始提取」先调 /api/estimate 拉取元数据
 *   B. 展示预估确认卡（时长 / 预计字数 / 预计 tokens）→ 用户确认后才真正提交
 *
 * 视觉方向：Apple 式克制留白 + OpenAI 式简洁层级，零装饰渐变
 */
import { useState } from 'react'
import {
  Input, Button, Upload, Typography,
  Collapse, Tag, Tooltip,
} from 'antd'
import {
  LinkOutlined, UploadOutlined, RocketOutlined,
  InfoCircleOutlined, StarFilled, ClockCircleOutlined,
  FileTextOutlined, ThunderboltOutlined, CloseOutlined,
} from '@ant-design/icons'
import api from '../hooks/api'

const { Text } = Typography

/** 秒 → "mm:ss" 或 "hh:mm:ss" */
function formatDuration(sec) {
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  const rr = String(r).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${rr}` : `${mm}:${rr}`
}

/** 千分位格式化 */
function formatNumber(n) {
  return n.toLocaleString('en-US')
}

export default function HomePage({ onSubmit }) {
  const [url, setUrl] = useState('')
  const [sessdata, setSessdata] = useState('')
  const [estimating, setEstimating] = useState(false)   // 正在拉取预估
  const [submitting, setSubmitting] = useState(false)   // 正在提交任务
  const [estimateData, setEstimateData] = useState(null) // 预估结果（非 null 即确认态）
  const [error, setError] = useState(null)

  // 第一步：拉取成本预估
  const handleEstimate = async () => {
    if (!url.trim()) return
    setEstimating(true)
    setError(null)
    try {
      const data = await api.estimate(url.trim())
      setEstimateData(data)
    } catch (e) {
      setError(e.message || '无法解析视频信息，请检查链接是否正确')
    } finally {
      setEstimating(false)
    }
  }

  // 第二步：确认后真正提交任务
  const handleConfirmSubmit = async () => {
    setSubmitting(true)
    setError(null)
    try {
      const res = await api.submit({ source: 'bilibili_url', url: url.trim(), sessdata: sessdata.trim() || null })
      onSubmit(res)
    } catch (e) {
      setError(e.message || '提交失败，请稍后重试')
      setSubmitting(false)
    }
  }

  // 取消确认，回到输入态
  const handleCancelEstimate = () => {
    setEstimateData(null)
    setError(null)
  }

  // 链接变化时清除已展示的预估（避免拿旧预估提交新链接）
  const handleUrlChange = (e) => {
    setUrl(e.target.value)
    if (estimateData) setEstimateData(null)
  }

  const handleUpload = async (file) => {
    setSubmitting(true)
    setError(null)
    try {
      const formData = new FormData()
      formData.append('file', file)
      if (sessdata.trim()) formData.append('sessdata', sessdata.trim())
      const res = await api.upload(formData)
      onSubmit(res)
    } catch (e) {
      setError(e.message || '上传失败，请重试')
      setSubmitting(false)
    }
    return false
  }

  const busy = estimating || submitting

  return (
    <div className="page-enter">
      {/* ── Hero 区域 ── */}
      <div style={{ textAlign: 'center', marginBottom: 44 }}>
        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '5px 14px',
          background: 'var(--accent-light)',
          borderRadius: '9999px',
          marginBottom: 20,
        }}>
          <StarFilled style={{ color: 'var(--accent)', fontSize: 11 }} />
          <span className="font-caption" style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--accent)',
          }}>
            Subtitle Extractor
          </span>
        </div>

        <h1 className="font-display font-display-lg" style={{ marginBottom: 12 }}>
          听见，然后读懂。
        </h1>
        <Text className="font-body" style={{ fontSize: 16, color: 'var(--mute)' }}>
          贴上 B 站链接，把视频里说的话变成可以阅读的文字
        </Text>
      </div>

      {/* ── 主输入卡片 ── */}
      <div className="card card--elevated" style={{ padding: '28px 28px 24px' }}>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* B站链接输入 */}
          <div>
            <label className="font-caption" style={{ display: 'block', marginBottom: 8 }}>
              Bilibili 链接
            </label>
            <Input
              placeholder="粘贴 B 站视频链接，如 https://b23.tv/..."
              size="large"
              value={url}
              onChange={handleUrlChange}
              onPressEnter={estimateData ? handleConfirmSubmit : handleEstimate}
              disabled={busy}
              prefix={<LinkOutlined style={{ color: 'var(--mute)' }} />}
              suffix={url && !busy && (
                <Button
                  type="text"
                  size="small"
                  icon={<CloseOutlined style={{ fontSize: 11 }} />}
                  onClick={() => { setUrl(''); setEstimateData(null) }}
                  style={{ color: 'var(--mute)' }}
                />
              )}
            />
          </div>

          {/* ── 成本预估确认卡（estimate 成功后滑入）── */}
          {estimateData && (
            <div className="estimate-enter" style={{
              background: 'var(--surface-2)',
              border: '1px solid var(--hairline)',
              borderRadius: 'var(--r-card)',
              padding: '16px 18px 14px',
            }}>
              {/* 视频标题 */}
              <div style={{
                fontSize: 14,
                fontWeight: 500,
                color: 'var(--ink)',
                lineHeight: 1.5,
                marginBottom: 12,
                overflow: 'hidden',
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
              }}>
                {estimateData.title}
              </div>

              {/* 计量行：时长 / 字数 / tokens */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <EstimateRow
                  icon={<ClockCircleOutlined />}
                  label="视频时长"
                  value={formatDuration(estimateData.duration_sec)}
                />
                <EstimateRow
                  icon={<FileTextOutlined />}
                  label="预计转写字数"
                  value={`约 ${formatNumber(estimateData.est_char_count)} 字`}
                />
                <EstimateRow
                  icon={<ThunderboltOutlined />}
                  label="智能整理预计消耗"
                  value={`约 ${formatNumber(estimateData.est_llm_tokens)} tokens`}
                  tooltip="语义分段由 LLM 完成，按输入 + 输出 tokens 计量"
                />
                {/* 积分系统上线后，在此处追加「预计消耗积分」行 */}
              </div>

              <div className="font-caption" style={{
                marginTop: 12,
                paddingTop: 10,
                borderTop: '1px dashed var(--hairline-strong)',
                fontSize: 12,
              }}>
                以上为预估，实际消耗以转写结果为准
              </div>
            </div>
          )}

          {/* 分割线 */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            color: 'var(--hairline-strong)',
            fontSize: 13,
          }}>
            <div style={{ flex: 1, height: 1, background: 'var(--hairline)' }} />
            <span className="font-caption">或</span>
            <div style={{ flex: 1, height: 1, background: 'var(--hairline)' }} />
          </div>

          {/* 文件上传 */}
          <Upload.Dragger
            beforeUpload={handleUpload}
            showUploadList={false}
            accept="video/*,.mp4,.mkv,.avi,.mov,.flv"
            multiple={false}
            disabled={busy}
            style={{ padding: '22px 0' }}
          >
            <div style={{ color: 'var(--mute)' }}>
              <UploadOutlined style={{ fontSize: 24, color: 'var(--hairline-strong)', marginBottom: 8, display: 'block' }} />
              <p className="font-body" style={{ fontSize: 14, marginBottom: 4 }}>点击或拖拽视频文件到此处</p>
              <p className="font-caption" style={{ marginBottom: 0 }}>MP4 / MKV / AVI / MOV / FLV · 按实际时长计量</p>
            </div>
          </Upload.Dragger>

          {/* 可选 SESSDATA */}
          <Collapse
            ghost
            expandIconPlacement="end"
            items={[{
              key: 'sessdata',
              label: (
                <span className="font-caption">
                  <InfoCircleOutlined style={{ marginRight: 6 }} />
                  可选：B 站登录令牌（更快提取 CC 字幕）
                </span>
              ),
              children: (
                <div style={{ paddingTop: 2 }}>
                  <Text className="font-body" style={{ fontSize: 13, color: 'var(--mute)', lineHeight: 1.65, display: 'block', marginBottom: 12 }}>
                    填写后 Stellaris 会尝试直接获取视频的 CC 字幕（更快、更准）。
                    不填也能正常使用，会走语音识别。
                  </Text>
                  <Input.Password
                    placeholder="SESSDATA（可选，留空跳过）"
                    value={sessdata}
                    onChange={(e) => setSessdata(e.target.value)}
                    size="middle"
                  />
                </div>
              ),
            }]}
          />

          {/* 错误提示 */}
          {error && (
            <div style={{
              padding: '10px 14px',
              background: 'var(--error-bg)',
              border: '1px solid #fecaca',
              borderRadius: 'var(--r-input)',
              color: 'var(--error)',
              fontSize: 13,
              lineHeight: 1.5,
            }}>
              {error}
            </div>
          )}

          {/* CTA 区：确认态 = 确认+取消；输入态 = 开始提取 */}
          {estimateData ? (
            <div style={{ display: 'flex', gap: 12 }}>
              <Button
                size="large"
                onClick={handleCancelEstimate}
                disabled={submitting}
                style={{ flex: '0 0 112px', borderRadius: 'var(--r-btn)', height: 44 }}
              >
                取消
              </Button>
              <Button
                type="primary"
                size="large"
                icon={<RocketOutlined />}
                loading={submitting}
                onClick={handleConfirmSubmit}
                block
              >
                确认并开始提取
              </Button>
            </div>
          ) : (
            <Button
              type="primary"
              size="large"
              icon={<RocketOutlined />}
              loading={estimating}
              onClick={handleEstimate}
              disabled={!url.trim() || submitting}
              block
            >
              {estimating ? '正在解析视频信息...' : '开始提取字幕'}
            </Button>
          )}

        </div>
      </div>

      {/* ── 底部版本标签 ── */}
      <div style={{ textAlign: 'center', marginTop: 32 }}>
        <Tag style={{
          background: 'transparent',
          color: 'var(--mute)',
          border: '1px solid var(--hairline)',
          borderRadius: '9999px',
          fontSize: 11,
          padding: '3px 12px',
          fontWeight: 500,
        }}>
          Stellaris · yt-dlp &amp; Mimo ASR &amp; DeepSeek
        </Tag>
      </div>
    </div>
  )
}

/* ── 子组件：预估计量行 ── */
function EstimateRow({ icon, label, value, tooltip }) {
  const labelEl = (
    <span className="font-caption" style={{ fontSize: 13 }}>
      {label}
      {tooltip && (
        <Tooltip title={tooltip}>
          <InfoCircleOutlined style={{ marginLeft: 5, fontSize: 11, color: 'var(--hairline-strong)' }} />
        </Tooltip>
      )}
    </span>
  )
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <span style={{ color: 'var(--mute)', fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 7 }}>
        <span style={{ color: 'var(--accent)', fontSize: 13 }}>{icon}</span>
        {labelEl}
      </span>
      <span className="font-mono" style={{ fontWeight: 500, color: 'var(--ink)', fontSize: 13 }}>
        {value}
      </span>
    </div>
  )
}
