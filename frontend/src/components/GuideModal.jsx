/**
 * 计费引导 — 分页沉浸式介绍（导航栏问号触发）
 * 四页：分钟 / 量子波 / 引力波 / 兑换与让利
 */
import { useState } from 'react'
import { Modal, Button } from 'antd'
import {
  ClockCircleOutlined, GlobalOutlined, DotChartOutlined,
  LeftOutlined, RightOutlined,
} from '@ant-design/icons'

const PAGES = [
  {
    icon: <ClockCircleOutlined style={{ fontSize: 26, color: 'var(--accent)' }} />,
    title: '分钟 · 转写的燃料',
    body: [
      '语音转写按视频时长计量，每天 0 点到凌晨 4 点间随时可用。',
      '免费用户：每日 30 分钟 / 每周 120 分钟 / 每月 300 分钟。',
      '每天凌晨 04:00（UTC+8）重置，熬夜不砍半。',
      '未登录也能体验：每天 10 分钟免费尝一口。',
    ],
    quote: '例：一个 16 分钟的视频，提取一次消耗 16 分钟额度，转写出约 2600 tokens 的字幕。',
  },
  {
    icon: <DotChartOutlined style={{ fontSize: 26, color: 'var(--accent)' }} />,
    title: '量子波 · 轻量 AI 货币',
    body: [
      '驱动智能功能：字幕语义分段、内容总结概要。',
      '汇率：1 量子波 = 100 tokens，按实际用量结算。',
      '每周一 04:00 重新发放赠送额度（未用完的赠送部分不结转）。',
      '做任务、清理数据可赚取永久量子波，攒着不消失。',
    ],
    quote: '例：16 分钟视频约 2600 tokens 字幕，智能分段（输入+输出）约 5200 tokens，按 100:1 结算为 52 量子波。',
  },
  {
    icon: <GlobalOutlined style={{ fontSize: 26, color: 'var(--accent)' }} />,
    title: '引力波 · 高级 AI 货币',
    body: [
      '驱动高级功能：Markdown 结构化笔记、AI 解读对话。',
      '汇率：1 引力波 = 500 tokens，按实际用量结算。',
      '注册即送 30 个，永不过期。',
      '可用量子波兑换（25:1，每月限 5 次）。',
    ],
    quote: '例：16 分钟视频生成 MD 笔记约消耗 5000 tokens，按 500:1 结算为 10 引力波；AI 解读每轮约 1500 tokens，结算为 3 引力波。',
  },
  {
    icon: <span style={{ fontSize: 22, fontFamily: "'Cormorant Garamond', serif", color: 'var(--accent)' }}>✦</span>,
    title: '双向兑换 · 零头免单',
    body: [
      '量子波 → 引力波：25:1，每月限 5 次。',
      '引力波 → 量子波：1:20，随时可兑（往返有折损，想好再换）。',
      '所有扣费都在成功后结算，失败分文不取。',
      '结算零头不到四成都免单——这是我们的小心意。',
    ],
    quote: '例：某次分段实际用了 440 tokens，只按 4 量子波结算——40 的零头免单。',
  },
]

export default function GuideModal({ open, onClose }) {
  const [page, setPage] = useState(0)

  return (
    <Modal open={open} onCancel={onClose} footer={null} width={440} centered>
      <div key={page} className="guide-page-enter" style={{ textAlign: 'center', padding: '4px 8px 0', minHeight: 240 }}>
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
          {/* 灰色引用示例 */}
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

      {/* 分页控制 */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginTop: 18,
      }}>
        <Button
          type="text" size="small" icon={<LeftOutlined />}
          disabled={page === 0}
          onClick={() => setPage(p => p - 1)}
        />
        <div style={{ display: 'flex', gap: 6 }}>
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
        {page < PAGES.length - 1 ? (
          <Button type="text" size="small" icon={<RightOutlined />} onClick={() => setPage(p => p + 1)} />
        ) : (
          <Button type="text" size="small" onClick={onClose} style={{ color: 'var(--accent)' }}>
            开始探索
          </Button>
        )}
      </div>
      {/* 翻页动画 */}
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
