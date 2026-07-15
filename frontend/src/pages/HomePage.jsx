/**
 * 页面 1：输入页 — Starlight 设计系统
 *
 * 衬线标题 + 矩形 CTA + 零装饰渐变
 */
import { useState } from 'react'
import {
  Input, Button, Upload, Typography,
  Collapse, Tag,
} from 'antd'
import {
  LinkOutlined, UploadOutlined, RocketOutlined,
  InfoCircleOutlined, StarFilled,
} from '@ant-design/icons'
import api from '../hooks/api'

const { Text } = Typography

export default function HomePage({ onSubmit }) {
  const [url, setUrl] = useState('')
  const [sessdata, setSessdata] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const handleSubmitLink = async () => {
    if (!url.trim()) return
    setLoading(true)
    setError(null)
    try {
      const res = await api.submit({ source: 'bilibili_url', url: url.trim(), sessdata: sessdata.trim() || null })
      onSubmit(res)
    } catch (e) {
      setError(e.message || '提交失败，请检查链接是否正确')
    } finally {
      setLoading(false)
    }
  }

  const handleUpload = async (file) => {
    setLoading(true)
    setError(null)
    try {
      const formData = new FormData()
      formData.append('file', file)
      if (sessdata.trim()) formData.append('sessdata', sessdata.trim())
      const res = await api.upload(formData)
      onSubmit(res)
    } catch (e) {
      setError(e.message || '上传失败，请重试')
    } finally {
      setLoading(false)
    }
    return false
  }

  return (
    <div>
      {/* ── Hero 区域：衬线标题 + 品牌 eyebrow ── */}
      <div style={{ textAlign: 'center', marginBottom: 48 }}>
        {/* Brand Eyebrow — pill shape, uppercase, positive tracking */}
        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '5px 14px',
          background: 'var(--accent-light)',
          borderRadius: '9999px',
          marginBottom: 20,
        }}>
          <StarFilled style={{ color: 'var(--accent)', fontSize: 12 }} />
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

        {/* Serif Display Title — Claude-inspired */}
        <h1 className="font-display font-display-lg" style={{ marginBottom: 10 }}>
          Stellaris
        </h1>
        <Text className="font-body" style={{ fontSize: 16, color: 'var(--mute)' }}>
          Turning voices into words you can read.
        </Text>
      </div>

      {/* ── 主输入卡片 ── */}
      <div className="card card--elevated" style={{ padding: '28px 28px 24px' }}>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>

          {/* B站链接输入 */}
          <div>
            <label className="font-caption" style={{ display: 'block', marginBottom: 8 }}>
              <LinkOutlined style={{ marginRight: 6, color: 'var(--accent)', fontSize: 13 }} />
              Bilibili 链接
            </label>
            <Input
              placeholder="粘贴 B 站视频链接..."
              size="large"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onPressEnter={handleSubmitLink}
              prefix={<LinkOutlined style={{ color: 'var(--mute)' }} />}
              suffix={url && (
                <Button
                  type="link"
                  size="small"
                  onClick={() => setUrl('')}
                  style={{ color: 'var(--mute)', padding: 0 }}
                >✕</Button>
              )}
            />
          </div>

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
          <div>
            <label className="font-caption" style={{ display: 'block', marginBottom: 8 }}>
              <UploadOutlined style={{ marginRight: 6, color: 'var(--body)', fontSize: 13 }} />
              上传视频文件
            </label>
            <Upload.Dragger
              beforeUpload={handleUpload}
              showUploadList={false}
              accept="video/*,.mp4,.mkv,.avi,.mov,.flv"
              multiple={false}
              style={{ padding: '26px 0' }}
            >
              <div style={{ color: 'var(--mute)' }}>
                <UploadOutlined style={{ fontSize: 26, color: 'var(--hairline-strong)', marginBottom: 8, display: 'block' }} />
                <p className="font-body" style={{ fontSize: 14, marginBottom: 4 }}>点击或拖拽视频到此处</p>
                <p className="font-caption" style={{ marginBottom: 0 }}>MP4 / MKV / AVI / MOV / FLV</p>
              </div>
            </Upload.Dragger>
          </div>

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
                    填写后 Stellaris 会尝试直接获取视频的 CC 字幕（更快、更准、免费）。
                    不填也能正常使用，会走语音识别。
                  </Text>
                  <Input.Password
                    placeholder="SESSDATA（可选，留空跳过）"
                    value={sessdata}
                    onChange={(e) => setSessdata(e.target.value)}
                    size="middle"
                  />
                  <div style={{ marginTop: 8 }}>
                    <Tag
                      style={{
                        background: 'var(--surface-2)',
                        color: 'var(--body)',
                        border: '1px solid var(--hairline)',
                        borderRadius: '9999px',
                        fontSize: 12,
                        cursor: 'pointer',
                        padding: '2px 10px',
                      }}
                    >
                      💡 怎么获取？
                    </Tag>
                  </div>
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

          {/* Primary CTA — Apple 式矩形按钮，零默认投影 */}
          <Button
            type="primary"
            size="large"
            icon={<RocketOutlined />}
            loading={loading}
            onClick={handleSubmitLink}
            disabled={!url.trim()}
            block
            style={{ fontWeight: 500 }}
          >
            开始提取字幕
          </Button>

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
          Nebula v0.0.1 · yt-dlp &amp; Mimo ASR
        </Tag>
      </div>
    </div>
  )
}
