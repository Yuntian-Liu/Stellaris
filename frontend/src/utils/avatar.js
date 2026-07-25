/**
 * 头像生成 — 本地化（V0.13.1）
 * 背景：api.dicebear.com 在线 API 故障（全球不可达），新用户注册选头像会全灭。
 * DiceBear 是 MIT 开源库，直接打包进前端本地生成 SVG data URI：
 * 零网络请求、无第三方单点、seed 规则与原来一致（micah 风格）。
 * 只引入 micah 一种风格，控制包体积。
 */
import { Style, Avatar } from '@dicebear/core'
import micahDefinition from '@dicebear/styles/micah.json'

const micahStyle = new Style(micahDefinition)

/** 与原来 https://api.dicebear.com/7.x/micah/svg?seed=xxx 等价的本地版 */
export function avatarUrl(seed) {
  return new Avatar(micahStyle, { seed: seed || 'stellaris' }).toDataUri()
}
