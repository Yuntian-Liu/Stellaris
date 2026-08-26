"""
自托管图形人机验证（V1.2.2，替代 Cloudflare Turnstile）

背景：Turnstile 挑战域名（challenges.cloudflare.com）在国内可达性劣化，
登录/注册大面积失败。改为 captcha 库本地生成字符/算术题图——
零第三方依赖、零数据出境、无"转圈失败"面。

安全模型（安全边界全在本模块，图形只是展示层）：
- 答案只存服务端内存：{captcha_id: (answer, expires_at)}，5 分钟过期
- 一次性：校验即删（无论对错），防重放
- captcha_id 用 uuid4，防枚举
- 生成端点 IP 限流（路由层，30/min）
- 懒清理：生成时顺手扫过期项，容量有界
- dev bypass：IS_PROD=false 直接放行；socket peer 为本机（127.0.0.1/::1）+ 魔数答案放行——
  本地联调即使 IS_PROD=true 也能跳过。**调用方必须传 request.client.host（socket peer），
  不得传 XFF 推导值**——XFF 是客户端可控头，传它等于把 bypass 开放给外网（ZCode 05 棒）
- 生产 fail-closed：答案错/过期/不存在一律拒绝
"""
import base64
import secrets
import threading
import time
import unicodedata
import uuid

from captcha.image import ImageCaptcha

from config import IS_PROD

CAPTCHA_TTL_SEC = 300          # 5 分钟过期
_DEV_ANSWER = "dev-bypass"     # 本机联调魔数（仅本机 IP 生效）

_store: dict[str, tuple[str, float]] = {}   # captcha_id → (answer, 过期时间戳)
_lock = threading.Lock()                     # to_thread 后 store 与渲染都跨线程（Codex 06 二轮）
_image = ImageCaptcha(width=160, height=60)

# 去混淆字符集：剔 0/O、1/I/L 等（手写+小屏场景）
_CHARS = "abcdefghjkmnpqrstuvwxyz23456789"


def _new_challenge() -> tuple[str, str]:
    """返回（图像文本, 正确答案）。纯 4 位随机字符——31 字符去混淆集，约 92 万组合
    （算术题 2+2~9+9 答案空间仅 1/30，已取消，Codex 06 二轮）"""
    text = "".join(secrets.choice(_CHARS) for _ in range(4))
    return text, text


def new_captcha() -> dict:
    """生成一道题，返回 {captcha_id, image(data URI)}"""
    # 懒清理 + 写库 + 渲染全在锁内（to_thread 并发安全；ImageCaptcha 首次字体缓存初始化也一并保护）
    with _lock:
        now = time.time()
        expired = [k for k, (_, exp) in _store.items() if exp < now]
        for k in expired:
            _store.pop(k, None)

        text, answer = _new_challenge()
        captcha_id = uuid.uuid4().hex
        _store[captcha_id] = (answer, now + CAPTCHA_TTL_SEC)
        png = _image.generate(text)
    return {
        "captcha_id": captcha_id,
        "image": "data:image/png;base64," + base64.b64encode(png.getvalue()).decode(),
    }


async def verify_captcha(captcha_id: str | None, answer: str | None,
                         remote_ip: str | None = None) -> bool:
    """
    校验图形验证码。
    - IS_PROD=false：bypass（开发模式）
    - 本机请求（127.0.0.1/::1）+ 魔数答案：dev bypass——本地开发即使
      IS_PROD=true（测真实发信）也能跳过（前提：调用方传的是 request.client.host
      而非 XFF 推导值——XFF 是客户端可控头，传它等于把 bypass 开放给外网）
    - 生产：一次性校验——校验即删（无论对错），答案错/过期/不存在一律 False
    """
    if not IS_PROD:
        return True
    if remote_ip in ("127.0.0.1", "::1", "localhost") and answer == _DEV_ANSWER:
        return True
    if not captcha_id or not answer:
        return False
    item = None
    with _lock:
        item = _store.pop(captcha_id, None)   # 一次性：无论对错都删除（锁内 pop，互斥闭合）
    if not item:
        return False
    expected, expires_at = item
    if time.time() > expires_at:
        return False
    # NFKC 归一：中文输入法全角数字/字母转半角，免得用户答对被判错
    return unicodedata.normalize("NFKC", answer.strip()).lower() == expected.lower()
