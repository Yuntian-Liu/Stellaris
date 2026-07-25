/**
 * 会员卡 — 设置页「会员权益」四档卡片
 * Stargazer ¥8 / Voyager ¥18（主推，挂 ¥5 试用小按钮）/ Odyssey ¥68 / Stella 仅邀请
 * 档位配色与 utils/tier.js 同源；开通跳转爱发电（/api/config 下发店铺链接）
 */
import { useEffect, useState } from 'react'
import { Button, Modal, Checkbox, message } from 'antd'
import {
  ClockCircleOutlined, DotChartOutlined, GlobalOutlined, HistoryOutlined,
  HeartOutlined,
} from '@ant-design/icons'
import { useAuth } from '../contexts/AuthContext'
import AgreementModal from './AgreementModal'

const TIERS = [
  {
    key: 'stargazer', name: 'Stargazer', cn: '观星者', price: 8,
    tag: '轻量尝鲜',
    gradient: 'linear-gradient(135deg, #4338ca, #6366f1)',
    benefits: [
      { icon: 'clock', text: <>每日 <b>40 分钟</b> 转写 · 月 480 分钟</> },
      { icon: 'quantum', text: <>量子波 <b>650</b>/周 · 约 7 次总结概要</> },
      { icon: 'gravity', text: <>引力波 <b>50</b>/月 · 约 8 篇 MD 笔记</> },
      { icon: 'history', text: <>历史记录保留 <b>24 小时</b></> },
    ],
  },
  {
    key: 'voyager', name: 'Voyager', cn: '远航者', price: 18, featured: true,
    tag: '主推',
    gradient: 'linear-gradient(135deg, #6d28d9, #8b5cf6)',
    benefits: [
      { icon: 'clock', text: <>每日 <b>100 分钟</b> 转写 · 月 1200 分钟</> },
      { icon: 'quantum', text: <>量子波 <b>1700</b>/周 · 约 22 次总结概要</> },
      { icon: 'gravity', text: <>引力波 <b>150</b>/月 · 约 25 篇 MD 笔记</> },
      { icon: 'history', text: <>历史记录保留 <b>7 天</b></> },
    ],
  },
  {
    key: 'odyssey', name: 'Odyssey', cn: '奥德赛', price: 68,
    tag: '量大管饱',
    gradient: 'linear-gradient(135deg, #92400e, #f59e0b)',
    benefits: [
      { icon: 'clock', text: <>每日 <b>300 分钟</b> 转写 · 月 3600 分钟</> },
      { icon: 'quantum', text: <>量子波 <b>5000</b>/周 · 约 61 次总结概要</> },
      { icon: 'gravity', text: <>引力波 <b>500</b>/月 · 约 83 篇 MD 笔记</> },
      { icon: 'history', text: <>历史记录保留 <b>30 天</b></> },
    ],
  },
  {
    key: 'stella', name: 'Stella', cn: '启明', price: null, inviteOnly: true,
    tag: '仅此一颗',
    gradient: 'linear-gradient(135deg, #1e1b4b, #6d28d9)',
    benefits: [
      { icon: 'clock', text: <>转写日/周 <b>不限</b> · 月 6000 分钟</> },
      { icon: 'quantum', text: <>量子波 <b>9999</b>/周 · 概要随心用</> },
      { icon: 'gravity', text: <>引力波 <b>500</b>/月 · 永不过期</> },
      { icon: 'history', text: <>历史记录 <b>永久保留</b></> },
    ],
  },
]

const ICONS = {
  clock: ClockCircleOutlined,
  quantum: DotChartOutlined,
  gravity: GlobalOutlined,
  history: HistoryOutlined,
}

export default function MembershipCards({ billing }) {
  const { user } = useAuth()
  const [shopUrl, setShopUrl] = useState('')
  const [planUrls, setPlanUrls] = useState({})
  useEffect(() => {
    fetch('/api/config').then(r => r.json())
      .then(c => {
        setShopUrl(c.afdian_shop_url || '')
        setPlanUrls(c.afdian_plan_urls || {})
      }).catch(() => {})
  }, [])

  // 会员协议有感确认（V0.9.3）：开通/赞赏前先弹"同意《会员协议》"，确认后才跳爱发电
  const [agreeOpen, setAgreeOpen] = useState(false)
  const [agreed, setAgreed] = useState(false)
  const [agreementOpen, setAgreementOpen] = useState(false)
  const [pendingTier, setPendingTier] = useState(null)

  // 跳爱发电付款：优先档位直链，附带 custom_order_id=UID（webhook 凭它关联发货对象）
  const doOpen = (tierKey) => {
    let url = planUrls[tierKey] || shopUrl
    if (!url) {
      message.info('会员开通即将上线，敬请期待')
      return
    }
    if (user?.uid) {
      url += (url.includes('?') ? '&' : '?') + `custom_order_id=${user.uid}`
    }
    window.open(url, '_blank')
  }

  // 先弹协议确认，再跳支付
  const openShop = (tierKey) => {
    setPendingTier(tierKey ?? null)   // 赞赏不传参 → null → 走通用店铺链接
    setAgreed(false)
    setAgreeOpen(true)
  }

  const confirmOpen = () => {
    setAgreeOpen(false)
    doOpen(pendingTier)
    setPendingTier(null)
  }

  const currentTier = billing?.tier
  // 任何会员身份（含试用/Stella）期间全部禁用开通；仅 free 状态可购买（碳碳定：升级走人工或到期再充）
  // stella 也在锁定名单：永久邀请档被付费档覆盖即蒸发，后端是"不同档覆盖"不设防（V0.13.1 补漏）
  // admin 不加：开发者保留支付测试通道，且有 is_admin 覆盖护体、后台可一键恢复
  const hasPaid = ['trial', 'stargazer', 'voyager', 'odyssey', 'stella'].includes(currentTier)
  const expireText = billing?.expire_at
    ? `有效期至 ${new Date(billing.expire_at).getMonth() + 1} 月 ${new Date(billing.expire_at).getDate()} 日`
    : null

  return (
    <>
    <div style={{
      display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(232px, 1fr))',
      gap: 14, marginBottom: 16,
    }}>
      {TIERS.map(t => {
        const isCurrent = currentTier === t.key
        const crossTierBlocked = hasPaid && !isCurrent && !t.inviteOnly
        // 试用中：Voyager 卡显示试用状态 + 主按钮变升级 CTA（试用→正式是转化主路径）
        const isTrialCard = currentTier === 'trial' && t.key === 'voyager'
        return (
          <div key={t.key} className="member-card" style={{
            borderRadius: 'var(--r-card)', overflow: 'hidden',
            border: isCurrent ? '1.5px solid var(--accent)' : '1px solid var(--hairline)',
            background: 'var(--surface-1)',
            boxShadow: t.featured ? '0 6px 24px rgba(109, 40, 217, 0.12)' : 'none',
            position: 'relative', display: 'flex', flexDirection: 'column',
          }}>
            {/* 卡片头：渐变 + 英文名 + 中文副标 */}
            <div className="member-card-head" style={{
              background: t.gradient, padding: '16px 18px 14px',
              position: 'relative', overflow: 'hidden',
            }}>
              <div style={{
                position: 'absolute', top: -20, right: -20, width: 80, height: 80,
                borderRadius: '50%', background: 'rgba(255,255,255,0.10)',
              }} />
              <div style={{
                position: 'absolute', bottom: 8, right: 16,
                color: 'rgba(255,255,255,0.35)', fontSize: 14,
              }}>✦</div>
              {t.tag && (
                <div style={{
                  position: 'absolute', top: 10, right: 12, fontSize: 10,
                  borderRadius: 9999, padding: '1px 8px', fontWeight: 500,
                  // 主推档反白实心突出，其余档半透明描边感
                  ...(t.featured
                    ? { color: '#6d28d9', background: '#fff' }
                    : { color: '#fff', background: 'rgba(255,255,255,0.22)' }),
                }}>{t.tag}</div>
              )}
              <div className="font-display" style={{
                color: '#fff', fontSize: 22, fontWeight: 600, letterSpacing: 0.5,
              }}>{t.name}</div>
              <div style={{ color: 'rgba(255,255,255,0.75)', fontSize: 12, marginTop: 1 }}>
                {t.cn}
              </div>
              <div style={{
                marginTop: 8, color: '#fff',
                height: 34, display: 'flex', alignItems: 'center', gap: 1,
              }}>
                {t.price != null ? (
                  <>
                    <span style={{ fontSize: 13, opacity: 0.85 }}>¥</span>
                    <span className="font-mono" style={{ fontSize: 26, fontWeight: 700, lineHeight: 1 }}>{t.price}</span>
                    <span style={{ fontSize: 12, opacity: 0.85 }}>&nbsp;/月</span>
                  </>
                ) : (
                  <span style={{ fontSize: 13, opacity: 0.9, letterSpacing: 1 }}>仅此一颗星</span>
                )}
              </div>
            </div>

            {/* 权益列表 */}
            <div style={{ padding: '12px 18px', flex: 1 }}>
              {t.benefits.map((b, i) => {
                const Icon = ICONS[b.icon]
                return (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    fontSize: 12.5, color: 'var(--body)', lineHeight: 2,
                  }}>
                    <Icon style={{ color: 'var(--accent)', fontSize: 12, flexShrink: 0 }} />
                    <span className="tier-benefit">{b.text}</span>
                  </div>
                )
              })}
            </div>

            {/* 底部按钮（无试用档后，上方占位保留以保证卡片按钮对齐） */}
            <div style={{ padding: '0 18px 16px' }}>
              <div style={{ minHeight: 22, marginBottom: 6, textAlign: 'center' }}>
                {isTrialCard && (
                  <span style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 500 }}>
                    试用中{expireText ? ` · ${expireText.replace('有效期至', '')} 到期` : ''}
                  </span>
                )}
              </div>
              {isCurrent ? (
                <Button block disabled>
                  当前档位{expireText ? ` · ${expireText}` : ''}
                </Button>
              ) : t.inviteOnly ? (
                <Button block disabled style={{ color: 'var(--mute)' }}>仅邀请</Button>
              ) : crossTierBlocked ? (
                <Button block disabled style={{ color: 'var(--mute)' }}>已开通其他档位</Button>
              ) : isTrialCard ? (
                <Button block disabled style={{ color: 'var(--mute)' }}>
                  试用中 · 到期后可开通
                </Button>
              ) : (
                <Button
                  block type="primary"
                  style={{ background: t.gradient, border: 'none', fontWeight: 500 }}
                  onClick={() => openShop(t.key)}
                >
                  开通 {t.name}
                </Button>
              )}
            </div>
          </div>
        )
      })}
    </div>

    {/* 换档说明（已开通付费档时显示） */}
    {hasPaid && (
      <div style={{
        textAlign: 'center', fontSize: 12, color: 'var(--mute)',
        marginBottom: 12, lineHeight: 1.7,
      }}>
        会员期间暂不可切换档位 · 到期后可自由选择 · 同档续费随时可用
      </div>
    )}

    {/* 赞赏入口（爱发电自选金额；也是支付链路的生产冒烟通道） */}
    <div style={{
      textAlign: 'center', marginTop: 4, marginBottom: 16,
      paddingTop: 14, borderTop: '1px dashed var(--hairline)',
    }}>
      <span style={{ fontSize: 12, color: 'var(--mute)', marginRight: 10 }}>
        星轨漫长，若这里曾照亮你 ✦
      </span>
      <Button
        size="small" type="text" icon={<HeartOutlined />}
        style={{ color: 'var(--accent)' }}
        onClick={openShop}
      >
        赞赏支持
      </Button>
    </div>

    {/* 开通/赞赏前的会员协议有感确认 */}
    <Modal open={agreeOpen} onCancel={() => setAgreeOpen(false)} width={420} centered footer={null}
      title={<span className="font-display">开通会员</span>}>
      <div style={{ fontSize: 13, color: 'var(--body)', lineHeight: 1.75, marginBottom: 16 }}>
        请阅读并同意《会员协议》，了解会员权益、虚拟资产发放规则与到期说明后，再前往支付。
      </div>
      <Checkbox checked={agreed} onChange={(e) => setAgreed(e.target.checked)}>
        我已阅读并同意
        <a onClick={() => setAgreementOpen(true)} style={{ color: 'var(--accent)', marginLeft: 4 }}>《会员协议》</a>
      </Checkbox>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
        <Button onClick={() => setAgreeOpen(false)}>取消</Button>
        <Button type="primary" disabled={!agreed} onClick={confirmOpen}>前往支付</Button>
      </div>
    </Modal>
    <AgreementModal open={agreementOpen} type="membership" onClose={() => setAgreementOpen(false)} />
  </>
  )
}
