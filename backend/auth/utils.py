"""
Auth 工具函数 — JWT、验证码、UID、密码哈希、密码强度、rate limit
对标 Datelife,迁移到 Python(passlib bcrypt 替代 Node scrypt)。
"""
import hashlib
import re
import secrets
import time
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from config import JWT_SECRET, JWT_ALGORITHM, JWT_EXPIRE_DAYS
from auth.models import User


# ===== 密码哈希(直接用 bcrypt 库,不通过 passlib——passlib 1.7.4 停更,不兼容 bcrypt 5.0)=====
def _prehash(plain: str) -> bytes:
    """sha256 预哈希:避开 bcrypt 72 字节限制,支持任意长度密码。"""
    return hashlib.sha256(plain.encode("utf-8")).hexdigest().encode("utf-8")


def hash_password(plain: str) -> str:
    """哈希密码(CPU 密集,调用方需 asyncio.to_thread 包)。bcrypt 自带 salt。"""
    return bcrypt.hashpw(_prehash(plain), bcrypt.gensalt(rounds=12)).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    """校验密码(CPU 密集,调用方需 asyncio.to_thread 包)。"""
    try:
        return bcrypt.checkpw(_prehash(plain), hashed.encode("utf-8"))
    except Exception:
        return False


# ===== 密码强度校验(≥8 位 + 字母 + 数字 + 符号)=====
_PASSWORD_SYMBOLS = set("!@#$%^&*()-_=+[]{}|;:,.<>?/")


def validate_password_strength(password: str) -> list[str]:
    """
    返回错误信息列表(空 = 通过)。
    规则:≥8 位、含字母、含数字、含符号。
    """
    errors = []
    if len(password) < 8:
        errors.append("密码至少 8 位")
    if not re.search(r"[A-Za-z]", password):
        errors.append("密码需包含字母")
    if not re.search(r"\d", password):
        errors.append("密码需包含数字")
    if not any(ch in _PASSWORD_SYMBOLS for ch in password):
        errors.append("密码需包含符号(!@#$%^&* 等)")
    return errors


# ===== JWT(HS256,30 天)=====
def create_access_token(uid: int, email: str) -> str:
    """签发 JWT。payload: {uid, email, exp, iat}"""
    now = datetime.now(timezone.utc)
    payload = {
        "uid": uid,
        "email": email,
        "exp": now + timedelta(days=JWT_EXPIRE_DAYS),
        "iat": now,
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_access_token(token: str) -> dict | None:
    """解码 JWT,过期/无效返回 None"""
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.PyJWTError:
        return None


# ===== 验证码生成 =====
def generate_code() -> str:
    """6 位数字验证码(secrets 安全随机)"""
    return f"{secrets.randbelow(1000000):06d}"


# ===== UID 生成(从 100000 起)=====
async def get_next_uid(db: AsyncSession) -> int:
    """COALESCE(MAX(uid), 99999) + 1。并发靠 uid UNIQUE 兜底(register 时 IntegrityError 重试)。"""
    result = await db.execute(select(func.coalesce(func.max(User.uid), 99999) + 1))
    return result.scalar_one()


# ===== send-code rate limit(内存 dict,IP 每分钟 3 次)=====
_send_code_rate: dict[str, list[float]] = {}
RATE_LIMIT_WINDOW_SEC = 60
RATE_LIMIT_MAX = 3


def get_client_ip(request) -> str:
    """P1-12 安全：从 X-Forwarded-For 取真实客户端 IP（Zeabur 代理后兼容），fallback request.client.host"""
    forwarded = request.headers.get("X-Forwarded-For", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def check_send_code_rate(ip: str) -> bool:
    """返回 True 允许发送,False 超限。进程重启清空(个人项目够用)。"""
    now = time.time()
    arr = [t for t in _send_code_rate.get(ip, []) if now - t < RATE_LIMIT_WINDOW_SEC]
    if len(arr) >= RATE_LIMIT_MAX:
        _send_code_rate[ip] = arr
        return False
    arr.append(now)
    _send_code_rate[ip] = arr
    return True


# ===== login rate limit（密码登录 IP 每分钟 10 次，P0-4 防暴力撞密码）=====
_login_rate: dict[str, list[float]] = {}
LOGIN_RATE_WINDOW_SEC = 60
LOGIN_RATE_MAX = 10


# 安全面板动态计数 + 事件记录（进程内存，重启清零；仅用于管理后台展示）
import time as _time
from collections import deque as _deque

_login_blocked_count: int = 0
_login_blocked_events: _deque = _deque(maxlen=50)  # 环形缓冲，最近 50 条


def check_login_rate(ip: str) -> bool:
    """密码登录 IP 限流：返回 True 允许，False 超限。"""
    global _login_blocked_count
    now = _time.time()
    arr = [t for t in _login_rate.get(ip, []) if now - t < LOGIN_RATE_WINDOW_SEC]
    if len(arr) >= LOGIN_RATE_MAX:
        _login_rate[ip] = arr
        _login_blocked_count += 1
        _login_blocked_events.append({
            "time": _time.strftime("%m-%d %H:%M:%S"), "ip": ip, "type": "login_blocked",
            "detail": f"IP {ip} 密码登录 {LOGIN_RATE_MAX}次/{LOGIN_RATE_WINDOW_SEC}秒 超限被拒",
        })
        return False
    arr.append(now)
    _login_rate[ip] = arr
    return True


def get_login_blocked_count() -> int:
    return _login_blocked_count


def get_login_blocked_events() -> list:
    return list(reversed(_login_blocked_events))
