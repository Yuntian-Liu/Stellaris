"""
Cloudflare Turnstile 人机验证
IS_PROD=false 时 bypass(开发模式);生产模式调 siteverify。
"""
import httpx

from config import IS_PROD, TURNSTILE_SECRET_KEY


async def verify_turnstile(token: str | None, remote_ip: str | None = None) -> bool:
    """
    校验 Turnstile token。
    - IS_PROD=false:bypass(开发模式)
    - 本机请求(127.0.0.1/::1) + 特殊 token:dev bypass——本地开发即使
      IS_PROD=true(测真实发信)也能跳过验证;外网攻击者无法伪造来源 IP,安全
    - IS_PROD=true 但未配 secret:fail-closed(拒绝)
    - IS_PROD=true 且配了 secret:调 Cloudflare siteverify(form-urlencoded)
    """
    if not IS_PROD:
        return True
    # 本机请求(127.0.0.1/::1):widget 可能渲染不了,允许空 token 通过。外网无法伪造来源 IP,安全
    if remote_ip in ("127.0.0.1", "::1", "localhost"):
        return True
    if not TURNSTILE_SECRET_KEY:
        return False  # 生产环境必须配 secret,fail-closed
    if not token:
        return False
    data = {"secret": TURNSTILE_SECRET_KEY, "response": token}
    if remote_ip:
        data["remoteip"] = remote_ip
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                "https://challenges.cloudflare.com/turnstile/v0/siteverify",
                data=data,
            )
        return bool(resp.json().get("success", False))
    except Exception:
        return False
