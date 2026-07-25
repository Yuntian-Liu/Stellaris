/**
 * 版权尾注文案（V0.12.5 定稿）——复制与前端文件导出的"出门盖章"
 * 存储层不污染：只追加到剪贴板文本与导出文件，DB/预览保持纯净
 * 后端 TXT/MD 下载的尾注在 backend/main.py（响应层追加，文案保持一致）
 */

/** 剪贴板短版（字幕复制 / 概要复制；AI 单条消息复制豁免） */
export const COPY_FOOTER =
  '\n\n—— 由 Stellaris 提取 · https://stellaris.ytunx.com/\n' +
  'Copyright © Yuntian-Liu. All Rights Reserved.'

/** 前端导出 MD 文件完整版（概要 .md / AI 对话导出 .md） */
export const FILE_FOOTER_MD =
  '\n\n---\n' +
  '> 本笔记由 [Stellaris](https://stellaris.ytunx.com/) 生成 · ' +
  '[GitHub 开源](https://github.com/Yuntian-Liu/Stellaris)\n' +
  '> Copyright © Yuntian-Liu. All Rights Reserved.\n'
