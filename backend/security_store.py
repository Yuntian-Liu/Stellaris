"""
安全面板——管理后台「安全」Tab 的数据源（V0.11.5 新增）

动态数据（实时拦截计数 + 事件记录）+ 静态基线（配置/常量）。
"""
from config import (
    ALLOWED_ORIGINS, MAX_VIDEO_SIZE_MB, JWT_EXPIRE_DAYS, JWT_SECRET,
    COS_SECRET_ID, COS_SECRET_KEY, COS_BUCKET,
    MIMO_API_KEY, LLM_API_KEY,
    TURNSTILE_SECRET_KEY, TURNSTILE_SITE_KEY,
    AFDIAN_API_TOKEN, RESEND_API_KEY,
)
from auth.utils import (
    RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_SEC,
    LOGIN_RATE_MAX, LOGIN_RATE_WINDOW_SEC,
    get_login_blocked_count, get_login_blocked_events,
)
from pipeline.download import get_ssrf_blocked_count, get_ssrf_events
import main as _m


def get_security_status() -> dict:
    # 汇聚三处事件，按时间倒序，取最近 50 条
    events = get_login_blocked_events() + get_ssrf_events() + list(reversed(_m._upload_rejected_events))
    events.sort(key=lambda e: e["time"], reverse=True)
    events = events[:50]

    return {
        "live": {
            "login_blocked": get_login_blocked_count(),
            "ssrf_blocked": get_ssrf_blocked_count(),
            "upload_rejected": _m._upload_rejected_count,
        },
        "events": events,
        "auth": {
            "jwt_expire_days": JWT_EXPIRE_DAYS,
            "bcrypt_rounds": 12,
            "password_min_length": 8,
            "password_complexity": ["字母", "数字", "符号"],
            "login_rate_limit": f"{LOGIN_RATE_MAX}次/{LOGIN_RATE_WINDOW_SEC}秒",
            "code_rate_limit": f"{RATE_LIMIT_MAX}次/{RATE_LIMIT_WINDOW_SEC}秒",
            "turnstile_on_send_code": bool(TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY),
            "turnstile_on_login": bool(TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY),
        },
        "network": {
            "cors_origins": ALLOWED_ORIGINS,
            "ssrf_protection": True,
            "max_upload_mb": MAX_VIDEO_SIZE_MB,
            "security_headers": True,
        },
        "keys": {
            "jwt_secret_set": JWT_SECRET != "dev-secret-change-me",
            "mimo_key_set": bool(MIMO_API_KEY),
            "llm_key_set": bool(LLM_API_KEY),
            "cos_configured": bool(COS_SECRET_ID and COS_SECRET_KEY and COS_BUCKET),
            "turnstile_secret_set": bool(TURNSTILE_SECRET_KEY),
            "afdian_token_set": bool(AFDIAN_API_TOKEN),
            "resend_key_set": bool(RESEND_API_KEY),
        },
        "p1_gaps": [],
    }
