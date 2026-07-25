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
  InfoCircleOutlined, ClockCircleOutlined,
  FileTextOutlined, ThunderboltOutlined, CloseOutlined,
} from '@ant-design/icons'
import api from '../hooks/api'
import { useAuth } from '../contexts/AuthContext'

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

/** 观星小诗（与结果页同款，每次访问随机一句） */
const STAR_POEMS = [
  '今夜星空清澈，适合聆听',
  '每段声音，都值得被读懂',
  '星光落在字里行间',
  '宇宙很大，慢慢读',
  '把声音，点亮成文字',
]

export default function HomePage({ onSubmit, onNeedAuth }) {
  const { user, loading: authLoading } = useAuth()
  const [url, setUrl] = useState('')
  const [sessdata, setSessdata] = useState('')
  const [estimating, setEstimating] = useState(false)   // 正在拉取预估
  const [submitting, setSubmitting] = useState(false)   // 正在提交任务
  const [estimateData, setEstimateData] = useState(null) // 预估结果（非 null 即确认态）
  const [uploadEstimate, setUploadEstimate] = useState(null) // 上传预估（选文件后填充，确认后清空）
  const [skipSegment, setSkipSegment] = useState(false)  // 降级：跳过智能分段（量子波不足时可选）
  const [error, setError] = useState(null)
  const [poem] = useState(() => STAR_POEMS[Math.floor(Math.random() * STAR_POEMS.length)])

  // 第一步：拉取成本预估
  const handleEstimate = async () => {
    if (!url.trim()) return
    setEstimating(true)
    setError(null)
    try {
      const data = await api.estimate(url.trim(), sessdata.trim())
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
      const res = await api.submit({
        source: 'bilibili_url',
        url: url.trim(),
        sessdata: sessdata.trim() || null,
        est_minutes: estimateData?.est_minutes ?? null,
        skip_segment: skipSegment,
      })
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
    if (uploadEstimate) setUploadEstimate(null)
    if (skipSegment) setSkipSegment(false)
  }

  // 前端用 <video>/<audio>.duration 估时长，复刻后端 estimate 公式，给 upload 也做预估卡。
  // 后端仍以 ffprobe 探到的时长为准扣费（防绕过），前端预估仅作 UX 参考。
  const getMediaDuration = (file) => new Promise((resolve) => {
    const el = document.createElement('video')
    el.preload = 'metadata'
    el.onloadedmetadata = () => {
      URL.revokeObjectURL(el.src)
      resolve(el.duration || 0)
    }
    el.onerror = () => {
      // <video> 对纯音频可能不触发 loadedmetadata，fallback 到 <audio>
      const audio = document.createElement('audio')
      audio.preload = 'metadata'
      audio.onloadedmetadata = () => {
        URL.revokeObjectURL(audio.src)
        resolve(audio.duration || 0)
      }
      audio.onerror = () => resolve(0)
      audio.src = URL.createObjectURL(file)
    }
    el.src = URL.createObjectURL(file)
  })
  const estimateUploadCost = (durationSec) => {
    // 常量与 backend/config.py 对齐：SPEECH_CHARS_PER_MIN=240, CHARS_PER_TOKEN=1.5, LLM_TOKEN_ROUNDTRIP_FACTOR=2.0
    const durationMin = durationSec / 60
    const estChars = Math.floor(durationMin * 240)
    const estTokens = Math.floor(estChars / 1.5 * 2.0)
    const estMinutes = Math.max(1, Math.ceil(durationMin))
    const estQuantum = Math.floor(estTokens / 100) + (estTokens % 100 > 40 ? 1 : 0)  // round_tokens 四成让利
    return { durationSec, estChars, estTokens, estMinutes, estQuantum }
  }

  // 第一步：选文件后估时长、展示预估卡（不立即上传，等用户确认）
  const handleUpload = async (file) => {
    setError(null)
    const durationSec = await getMediaDuration(file)
    if (!durationSec || durationSec <= 0) {
      setError('无法识别媒体时长，请检查文件是否损坏或格式不受支持')
      return false
    }
    setEstimateData(null)   // 互斥：拖文件后只走上传预估态
    setUploadEstimate({ file, ...estimateUploadCost(durationSec) })
    return false   // 阻止 antd 自动上传
  }

  // 第二步：确认后才真正上传
  const handleConfirmUpload = async () => {
    const file = uploadEstimate?.file
    if (!file) return
    setSubmitting(true)
    setError(null)
    try {
      const formData = new FormData()
      formData.append('file', file)
      if (sessdata.trim()) formData.append('sessdata', sessdata.trim())
      const res = await api.upload(formData)
      setUploadEstimate(null)
      onSubmit(res)
    } catch (e) {
      setError(e.message || '上传失败，请重试')
      setSubmitting(false)
    }
  }

  const busy = estimating || submitting

  return (
    <div className="page-enter">
      {/* ── Hero 区域（微光星点氛围）── */}
      <div className="hero-glow-container" style={{ textAlign: 'center', marginBottom: 44, position: 'relative' }}>
        {/* 星点：极克制的闪烁（藏星主题） */}
        <span className="star-dot" style={{ top: -18, left: '12%', fontSize: 13, animationDelay: '0s' }}>✦</span>
        <span className="star-dot" style={{ top: 8, right: '15%', fontSize: 10, animationDelay: '0.9s' }}>✦</span>
        <span className="star-dot" style={{ top: 64, left: '6%', fontSize: 9, animationDelay: '1.7s' }}>✦</span>
        <span className="star-dot" style={{ top: 96, right: '8%', fontSize: 12, animationDelay: '2.4s' }}>✦</span>
        <span className="star-dot" style={{ top: 122, left: '20%', fontSize: 8, animationDelay: '3s' }}>✦</span>
        {/* 标题后的柔和光晕 */}
        <div style={{
          position: 'absolute',
          top: '40%', left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 480, height: 220,
          background: 'radial-gradient(ellipse at center, rgba(99,102,241,0.07) 0%, transparent 70%)',
          pointerEvents: 'none',
        }} />
        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '5px 14px',
          background: 'var(--accent-light)',
          borderRadius: '9999px',
          marginBottom: 20,
          position: 'relative',
        }}>
          <span style={{ color: 'var(--accent)', fontSize: 13, lineHeight: 1, fontFamily: "'Cormorant Garamond', serif" }}>✦</span>
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
          贴上视频链接，<span className="hero-subtitle-line2">把视频里说的话变成可以阅读的文字</span>
        </Text>
      </div>

      {/* ── 主输入卡片 ── */}
      <div className="card card--elevated" style={{ padding: '28px 28px 24px' }}>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* 视频链接输入 */}
          <div>
            <label className="font-caption" style={{ display: 'block', marginBottom: 8 }}>
              视频链接
            </label>
            <Input
              placeholder="粘贴视频链接（B站 / 小红书 / YouTube；抖音暂不支持）"
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
                {/* 计费消耗行（V0.7.0） */}
                <EstimateRow
                  icon={<ClockCircleOutlined />}
                  label="本次消耗"
                  value={`${estimateData.est_minutes} 分钟 + ${estimateData.est_quantum} 量子波`}
                  tooltip="分钟用于语音转写，量子波用于智能分段；结算按实际用量，零头不到四成免单"
                />
                {estimateData.minutes_left && (() => {
                  // 周期值为 null = 该周期不限（如 Stella 日/周），只在有上限的周期里取最小
                  const vals = Object.values(estimateData.minutes_left).filter(v => v !== null)
                  if (!vals.length) return null
                  return (
                    <EstimateRow
                      icon={<FileTextOutlined />}
                      label="当前余量"
                      value={`${Math.min(...vals)} 分钟 · ${estimateData.quantum_left} 量子波`}
                    />
                  )
                })()}
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
            accept="video/*,audio/*,.mp4,.mkv,.avi,.mov,.flv,.mp3,.m4a,.wav,.ogg,.flac,.aac"
            multiple={false}
            disabled={busy}
            style={{ padding: '22px 0' }}
          >
            <div style={{ color: 'var(--mute)' }}>
              <UploadOutlined style={{ fontSize: 24, color: 'var(--hairline-strong)', marginBottom: 8, display: 'block' }} />
              <p className="font-body" style={{ fontSize: 14, marginBottom: 4 }}>点击或拖拽视频 / 音频文件到此处</p>
              <p className="font-caption" style={{ marginBottom: 0 }}>MP4 / MKV / AVI / MOV / FLV / MP3 / M4A / WAV · 按实际时长计量</p>
            </div>
          </Upload.Dragger>

          {/* ── 上传成本预估确认卡（选文件后滑入，与链接预估卡同款样式）── */}
          {uploadEstimate && (
            <div className="estimate-enter" style={{
              background: 'var(--surface-2)',
              border: '1px solid var(--hairline)',
              borderRadius: 'var(--r-card)',
              padding: '16px 18px 14px',
            }}>
              <div style={{
                fontSize: 14, fontWeight: 500, color: 'var(--ink)',
                lineHeight: 1.5, marginBottom: 12,
                overflow: 'hidden', display: '-webkit-box',
                WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
              }}>
                {uploadEstimate.file.name}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <EstimateRow icon={<ClockCircleOutlined />} label="时长" value={formatDuration(uploadEstimate.durationSec)} />
                <EstimateRow icon={<FileTextOutlined />} label="预计转写字数" value={`约 ${formatNumber(uploadEstimate.estChars)} 字`} />
                <EstimateRow icon={<ThunderboltOutlined />} label="智能整理预计消耗" value={`约 ${formatNumber(uploadEstimate.estTokens)} tokens`} tooltip="语义分段由 LLM 完成，按输入 + 输出 tokens 计量" />
                <EstimateRow icon={<ClockCircleOutlined />} label="本次消耗" value={`${uploadEstimate.estMinutes} 分钟 + ${uploadEstimate.estQuantum} 量子波`} tooltip="分钟用于语音转写，量子波用于智能分段；结算按实际用量，零头不到四成免单" />
              </div>
              <div className="font-caption" style={{
                marginTop: 10, paddingTop: 10,
                borderTop: '1px dashed var(--hairline-strong)', fontSize: 12,
              }}>
                以上为预估，实际消耗以转写结果为准
              </div>
            </div>
          )}

          {/* 可选 SESSDATA */}
          <Collapse
            ghost
            expandIconPlacement="end"
            items={[{
              key: 'sessdata',
              label: (
                <span className="font-caption">
                  <InfoCircleOutlined style={{ marginRight: 6 }} />
                  可选：B 站登录令牌（仅 B 站链接，更快提取 CC 字幕）
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
            (() => {
              const minutesOk = !estimateData.minutes_left ||
                Object.values(estimateData.minutes_left).every(
                  v => v === null || estimateData.est_minutes <= v)
              const quantumOk = estimateData.quantum_left == null ||
                estimateData.est_quantum <= estimateData.quantum_left
              const canSubmit = minutesOk && (quantumOk || skipSegment)
              return (
                <div>
                  {/* 降级选项：分钟够但量子波不够时才出现 */}
                  {minutesOk && !quantumOk && (
                    <div style={{
                      marginBottom: 12, padding: '10px 14px',
                      background: 'var(--accent-light)', borderRadius: 'var(--r-input)',
                      fontSize: 13, color: 'var(--body)', lineHeight: 1.6,
                    }}>
                      量子波不足以支付智能分段（需 {estimateData.est_quantum}，剩 {estimateData.quantum_left}）。
                      <label style={{ marginLeft: 6, cursor: 'pointer', color: 'var(--accent)', fontWeight: 500 }}>
                        <input
                          type="checkbox"
                          checked={skipSegment}
                          onChange={e => setSkipSegment(e.target.checked)}
                          style={{ marginRight: 5 }}
                        />
                        跳过分段继续转写（输出原始切分文本）
                      </label>
                    </div>
                  )}
                  {!minutesOk && (
                    <div style={{
                      marginBottom: 12, padding: '10px 14px',
                      background: 'var(--error-bg)', borderRadius: 'var(--r-input)',
                      fontSize: 13, color: 'var(--error)', lineHeight: 1.6,
                    }}>
                      分钟额度不足，本视频约需 {estimateData.est_minutes} 分钟。额度每日 04:00 重置。
                    </div>
                  )}
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
                      disabled={!canSubmit}
                      block
                    >
                      {skipSegment ? '确认（跳过分段）' : '确认并开始提取'}
                    </Button>
                  </div>
                </div>
              )
            })()
          ) : uploadEstimate ? (
            <div style={{ display: 'flex', gap: 12 }}>
              <Button
                size="large"
                onClick={() => { setUploadEstimate(null); setError(null) }}
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
                onClick={handleConfirmUpload}
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

      {/* ── 匿名权益提示条（仅未登录显示；「了解权益」事件总线开计费引导，同 open-exchange 先例）── */}
      {!user && !authLoading && (
        <div style={{
          marginTop: 16,
          textAlign: 'center',
          fontSize: 12,
          color: 'var(--mute)',
          lineHeight: 1.8,
        }}>
          游客体验中 · 每日 10 分钟免费转写 · 注册解锁 内容总结 / MD 笔记 / AI 解读 / 云端历史，即送 30 引力波
          <span style={{ marginLeft: 8, whiteSpace: 'nowrap' }}>
            <a
              onClick={() => window.dispatchEvent(new CustomEvent('stellaris:open-guide'))}
              style={{ color: 'var(--accent)', cursor: 'pointer' }}
            >
              了解权益
            </a>
            <span style={{ margin: '0 4px', color: 'var(--hairline-strong)' }}>/</span>
            <a onClick={onNeedAuth} style={{ color: 'var(--accent)', cursor: 'pointer', fontWeight: 500 }}>
              立即注册
            </a>
          </span>
        </div>
      )}

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
          Stellaris · 多平台视频字幕提取
        </Tag>
      </div>

      {/* ── 页脚签名（悬停浮现观星小诗，与结果页同款彩蛋）── */}
      <div className="footer-sig" style={{ textAlign: 'center', marginTop: 14 }}>
        <div className="footer-poem" style={{
          fontSize: 12,
          color: 'var(--accent)',
          fontFamily: "'Cormorant Garamond', serif",
          letterSpacing: '0.08em',
          marginBottom: 4,
        }}>
          {poem}
        </div>
        <Text className="font-caption" style={{ color: 'var(--hairline-strong)' }}>
          Stellaris · Made with care
        </Text>
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
