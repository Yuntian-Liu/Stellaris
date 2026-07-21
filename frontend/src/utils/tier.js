/**
 * 会员档位元数据 — 徽章配色 / 头像框
 * P2 会员卡渐变与这里同源，全站档位视觉统一
 */
export const TIER_META = {
  free: {
    label: '免费版', cn: '',
    color: '#8a8f99', bg: 'var(--surface-2)', ring: null,
  },
  trial: {
    label: 'Trial', cn: '体验舱',
    color: '#7c3aed', bg: '#f3e8ff', ring: '#c4b5fd',
  },
  stargazer: {
    label: 'Stargazer', cn: '观星者',
    color: '#4f46e5', bg: '#eef2ff', ring: '#818cf8',
  },
  voyager: {
    label: 'Voyager', cn: '远航者',
    color: '#7c3aed', bg: '#f3e8ff', ring: '#a78bfa',
  },
  odyssey: {
    label: 'Odyssey', cn: '奥德赛',
    color: '#b45309', bg: '#fef3c7', ring: '#f59e0b',
  },
  stella: {
    label: 'Stella', cn: '启明',
    color: '#6d28d9', bg: '#ede9fe', ring: '#8b5cf6',
  },
  admin: {
    label: '开发者', cn: '',
    color: '#a16207', bg: '#fef9c3', ring: '#eab308',
  },
}

export const tierMeta = (key) => TIER_META[key] || TIER_META.free

/** 各档位历史保留时长文案（结果页提示用） */
export const RETENTION_TEXT = {
  free: '1 小时',
  stargazer: '24 小时',
  voyager: '7 天',
  odyssey: '30 天',
  stella: '永久',
  admin: '永久',
}

/** 各档位历史弹窗空态文案（星空语境；空态是会员权益的第一印象） */
export const RETENTION_COPY = {
  free: '记录将保留 1 小时 · 开通会员，让星光停留更久',
  stargazer: '观星者，你的星轨会在此停留 24 小时',
  voyager: '远航者，你的星轨会在此停留 7 天',
  odyssey: '奥德赛，你的星轨会在此停留 30 天',
  stella: '启明长明 · 你的星轨永不消散',
  admin: '开发者 · 你的星轨永不消散',
}
