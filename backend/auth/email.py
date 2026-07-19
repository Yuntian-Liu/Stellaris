"""
Resend 邮件 — 验证码邮件
开发模式(IS_PROD=false)打印到日志不真发;生产模式调 Resend REST API。
HTML 用 table 布局(邮件客户端兼容)+ 星空主题(深空渐变 + 星标)。
"""
import asyncio

import httpx

from config import IS_PROD, RESEND_API_KEY, RESEND_FROM


def _render_verification_html(code: str) -> str:
    """星空主题验证码邮件 HTML(table 布局 + 内联 CSS)"""
    return f"""\
<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f0c29;font-family:'LXGW WenKai','Noto Sans SC',-apple-system,BlinkMacSystemFont,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#0f0c29 0%,#1a1a4e 50%,#302b63 100%);padding:40px 16px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.4)">
        <!-- 品牌头:深空渐变 + 星标 -->
        <tr>
          <td style="background:linear-gradient(135deg,#1e1b4b 0%,#4f46e5 100%);padding:32px 24px;text-align:center">
            <div style="font-size:14px;color:#a5b4fc;letter-spacing:6px;margin-bottom:8px">&#10022; &#10023; &#10022;</div>
            <div style="font-size:28px;font-weight:800;color:#ffffff;letter-spacing:2px">&#9733; Stellaris</div>
            <div style="font-size:12px;color:#c7d2fe;margin-top:8px;letter-spacing:1px">把声音变成你能读到的文字</div>
          </td>
        </tr>
        <!-- 主内容 -->
        <tr>
          <td style="padding:36px 28px 12px;text-align:center">
            <p style="color:#475569;font-size:15px;margin:0 0 4px">你的邮箱正在用于登录 Stellaris</p>
            <p style="color:#94a3b8;font-size:12px;margin:0 0 24px">请使用下方验证码完成验证</p>
            <!-- 验证码区 -->
            <div style="background:linear-gradient(135deg,#eef2ff 0%,#e0e7ff 100%);border:2px dashed #818cf8;border-radius:16px;padding:24px 16px;margin:0 0 20px">
              <div style="color:#4338ca;font-size:11px;font-weight:700;letter-spacing:3px;margin-bottom:10px;text-transform:uppercase">Verification Code</div>
              <div style="font-size:42px;font-weight:800;letter-spacing:12px;color:#312e81;font-family:'Courier New',monospace">{code}</div>
            </div>
            <!-- 有效期提示 -->
            <div style="display:inline-block;background:#fef3c7;border-radius:20px;padding:6px 14px;margin-bottom:8px">
              <span style="color:#92400e;font-size:12px;font-weight:600">&#9201; 验证码 5 分钟内有效,请勿泄露</span>
            </div>
          </td>
        </tr>
        <!-- 安全提示 -->
        <tr>
          <td style="padding:8px 28px 24px;text-align:center">
            <div style="color:#94a3b8;font-size:12px;line-height:1.7">
              &#128737; 如果这不是你本人的操作,请忽略此邮件<br>账号安全由你自己守护
            </div>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="padding:16px 28px 24px;border-top:1px solid #f1f5f9;text-align:center">
            <p style="color:#cbd5e1;font-size:11px;margin:0;line-height:1.7">
              此邮件由系统自动发送,请勿直接回复<br>
              <span style="color:#4f46e5;font-weight:700">Stellaris</span> &middot; Turning voices into words you can read
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>"""


def _send_via_resend_sync(email: str, html: str) -> None:
    """同步调 Resend REST API(放线程池跑,不阻塞事件循环)"""
    if not RESEND_API_KEY:
        raise RuntimeError("RESEND_API_KEY 未配置")
    resp = httpx.post(
        "https://api.resend.com/emails",
        headers={
            "Authorization": f"Bearer {RESEND_API_KEY}",
            "Content-Type": "application/json",
        },
        json={
            "from": RESEND_FROM,
            "to": [email],
            "subject": "【Stellaris】登录验证码",
            "html": html,
        },
        timeout=30.0,
    )
    if resp.status_code >= 400:
        raise RuntimeError(f"Resend 返回 {resp.status_code}: {resp.text}")


async def send_verification_code(email: str, code: str) -> None:
    """
    发验证码邮件。
    IS_PROD=false:打印到日志(开发模式不烧 Resend 额度)
    IS_PROD=true:渲染 HTML + 调 Resend(放线程池)
    """
    if not IS_PROD:
        print(f"\n[DEV] Stellaris 验证码 → {email} : {code}\n")
        return
    html = _render_verification_html(code)
    await asyncio.to_thread(_send_via_resend_sync, email, html)
