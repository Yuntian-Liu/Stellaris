/**
 * 文件柜引导 — 分页沉浸式介绍（首次进入文件柜自动弹出，可随时从工具行重开）
 * 四页：是什么 / 怎么存 / 能做什么 / 边界与理念
 */
import { useState, useEffect } from 'react'
import { Modal, Button } from 'antd'
import {
  CloudOutlined, DownloadOutlined, FolderOpenOutlined,
  SafetyOutlined, LeftOutlined, RightOutlined,
} from '@ant-design/icons'

const PAGES = [
  {
    icon: <CloudOutlined style={{ fontSize: 26, color: 'var(--accent)' }} />,
    title: '文件柜 · 你的云端书架',
    body: [
      '把提取结果存进云端，不下载也能随时看。',
      '字幕、全文、笔记、概要、AI 解读——提取的一切都能存。',
      'Markdown 笔记和概要直接渲染成漂亮排版，公式、表格原样呈现。',
      '手机、电脑、平板，打开网站就是你的书架。',
    ],
    quote: '不是每个人都装了 Markdown 编辑器。现在，不需要了。',
  },
  {
    icon: <DownloadOutlined style={{ fontSize: 26, color: 'var(--accent)' }} />,
    title: '怎么存 · 藏在下载按钮里',
    body: [
      '在结果页找到任意产物的「下载」按钮。',
      '悬浮或点击它，选「转存到文件柜」。',
      '可以改文件名、选目标文件夹，一秒入库。',
      '同一个视频想存几次都行，会自动编号不冲突。',
    ],
    quote: '例：提取完一个视频，点「下载 → 转存到文件柜」，笔记就永久躺在你的书架上了。',
  },
  {
    icon: <FolderOpenOutlined style={{ fontSize: 26, color: 'var(--accent)' }} />,
    title: '能做什么 · 不止是存',
    body: [
      '在线查看：渲染排版与原文随时切换。',
      '随时下载回本地，文件名原样奉还。',
      '文件夹整理、重命名、移动，都像网盘一样顺手。',
      '与提取记录互不影响：记录到期清理，柜子里的副本安然无恙。',
    ],
    quote: '删除文件柜里的内容不可恢复——但它也永远不会被自动清理。',
  },
  {
    icon: <SafetyOutlined style={{ fontSize: 26, color: 'var(--accent)' }} />,
    title: '边界 · 它不是网盘',
    body: [
      '只收本站生成的提取产物，不支持上传任意文件。',
      '内测配额 5 MB——纯文本其实很能装，几百篇笔记不在话下。',
      '想要更大空间，找开发者聊聊就好。',
      '这个设计的初衷：让每一份提取结果，都有一个随时能回去的家。',
    ],
    quote: '我们希望它做一件小事，并把这件小事做好。',
  },
]

export default function VaultGuideModal({ open, onClose }) {
  const [page, setPage] = useState(0)
  // 每次打开回到第一页
  useEffect(() => { if (open) setPage(0) }, [open])

  return (
    <Modal open={open} onCancel={onClose} footer={null} width={440} centered>
      <div key={page} className="guide-page-enter" style={{ textAlign: 'center', padding: '4px 8px 0', height: 288, overflowY: 'auto' }}>
        <div style={{ marginBottom: 10 }}>{PAGES[page].icon}</div>
        <h3 className="font-display" style={{ fontSize: 17, margin: '0 0 14px' }}>
          {PAGES[page].title}
        </h3>
        <div style={{ textAlign: 'left', margin: '0 auto', maxWidth: 340 }}>
          {PAGES[page].body.map((line, i) => (
            <p key={i} style={{ fontSize: 13, color: 'var(--body)', lineHeight: 1.9, margin: '0 0 4px' }}>
              {line}
            </p>
          ))}
          <div style={{
            marginTop: 12,
            padding: '8px 12px',
            borderLeft: '3px solid var(--hairline-strong)',
            background: 'var(--surface-2)',
            borderRadius: '0 8px 8px 0',
            fontSize: 12,
            color: 'var(--mute)',
            lineHeight: 1.7,
          }}>
            {PAGES[page].quote}
          </div>
        </div>
      </div>

      {/* 分页控制（左右等宽槽位，圆点永远居中） */}
      <div style={{ display: 'flex', alignItems: 'center', marginTop: 18 }}>
        <div style={{ width: 72, display: 'flex', justifyContent: 'flex-start' }}>
          <Button
            type="text" size="small" icon={<LeftOutlined />}
            disabled={page === 0}
            onClick={() => setPage(p => p - 1)}
          />
        </div>
        <div style={{ flex: 1, display: 'flex', gap: 6, justifyContent: 'center' }}>
          {PAGES.map((_, i) => (
            <span
              key={i}
              onClick={() => setPage(i)}
              style={{
                width: 6, height: 6, borderRadius: '50%', cursor: 'pointer',
                background: i === page ? 'var(--accent)' : 'var(--hairline-strong)',
                transition: 'background 0.2s',
              }}
            />
          ))}
        </div>
        <div style={{ width: 72, display: 'flex', justifyContent: 'flex-end' }}>
          {page < PAGES.length - 1 ? (
            <Button type="text" size="small" icon={<RightOutlined />} onClick={() => setPage(p => p + 1)} />
          ) : (
            <Button type="text" size="small" onClick={onClose} style={{ color: 'var(--accent)' }}>
              开始使用
            </Button>
          )}
        </div>
      </div>
      <style>{`
        @keyframes guidePageEnter {
          from { opacity: 0; transform: translateX(14px); }
          to   { opacity: 1; transform: translateX(0); }
        }
        .guide-page-enter { animation: guidePageEnter 0.3s cubic-bezier(0.4, 0, 0.2, 1) both; }
        @media (prefers-reduced-motion: reduce) {
          .guide-page-enter { animation: none !important; }
        }
      `}</style>
    </Modal>
  )
}
