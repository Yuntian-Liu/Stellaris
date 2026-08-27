"""
Auth 路由 — /api/auth/*
步骤2:check-email / send-code / login-code
步骤3:register / login-password / me / profile
"""
import asyncio
import logging
import re
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request

logger = logging.getLogger(__name__)
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from auth.models import User, VerificationCode
from auth.schemas import (
    CheckEmailRequest, CheckEmailResponse,
    SendCodeRequest, SendCodeResponse,
    LoginCodeRequest, LoginCodeResponse, UserPublic,
    RegisterRequest, LoginPasswordRequest, UpdateProfileRequest,
    ChangePasswordRequest, ResetPasswordRequest,
)
from auth.utils import (
    generate_code, check_send_code_rate, check_login_rate, get_client_ip, create_access_token,
    hash_password, verify_password, validate_password_strength, get_next_uid,
)
from auth.email import send_verification_code
from auth.captcha import verify_captcha
from auth.dependencies import get_current_user

router = APIRouter(prefix="/api/auth", tags=["auth"])

CODE_EXPIRE_MINUTES = 5
CODE_MAX_ATTEMPTS = 5


def _user_to_public(user: User) -> UserPublic:
    """ORM User → 对外 UserPublic(脱去密码哈希等敏感字段)"""
    return UserPublic(
        uid=user.uid, email=user.email, nickname=user.nickname,
        avatar_seed=user.avatar_seed, bio=user.bio, is_admin=user.is_admin,
    )


def _is_expired(expires_at: datetime) -> bool:
    """验证码过期判断(兼容 naive/aware datetime)"""
    now = datetime.now(timezone.utc)
    exp = expires_at if expires_at.tzinfo else expires_at.replace(tzinfo=timezone.utc)
    return now > exp


# ===== 步骤2:邮箱验证码登录环路 =====

@router.post("/check-email", response_model=CheckEmailResponse)
async def check_email(req: CheckEmailRequest, db: AsyncSession = Depends(get_db)):
    """检查邮箱是否已注册"""
    result = await db.execute(select(User.uid).where(User.email == req.email))
    exists = result.scalar_one_or_none() is not None
    # need_invite 本期固定 False(无内测限制,预留)
    return CheckEmailResponse(exists=exists, need_invite=False)


def _resolve_identity(raw: str) -> tuple[str, str]:
    """身份解析（send-code/login-code/reset-password/login-password 共用，V1.3.0 Codex 02/03 棒）。
    返回 ("email", 规范化邮箱) 或 ("uid", 归一化 UID 字符串)。
    - 含 @ → email_validator 校验并用其 normalized 值（与 RegisterRequest 的 EmailStr 同标准，
      大写域名归一，避免"发码到 New@Test.COM、注册查 New@test.com"死胡同）
    - 纯 ASCII 数字（1-18 位，前导零允许）→ UID；不静默 strip（带空白即非法）
    - 其他 → 422
    """
    from email_validator import validate_email as _ev, EmailNotValidError
    s = raw or ""
    if "@" in s:
        try:
            return "email", _ev(s, check_deliverability=False).normalized
        except EmailNotValidError:
            raise HTTPException(status_code=422, detail="邮箱格式不正确")
    if re.fullmatch(r"[0-9]{1,18}", s):
        return "uid", str(int(s))
    raise HTTPException(status_code=422, detail="请输入正确的邮箱地址或 UID")


@router.post("/send-code", response_model=SendCodeResponse)
async def send_code(
    req: SendCodeRequest,
    request: Request,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    """发送验证码:图形验证码 → rate limit → 生码 → upsert → 后台发邮件

    V1.3.0：email 字段兼容邮箱或 UID（_resolve_identity 分流）。
    防 UID 枚举（Codex 02 棒）：UID 不存在时响应与"已发送"逐字段一致、不真发；
    邮件统一后台发送——失败只记日志，存在/不存在 UID 的响应与时序无差别。"""
    client_ip = get_client_ip(request)  # P1-12: X-Forwarded-For 拿真实 IP

    # V1.2.2：自托管图形验证码（替代 Turnstile）。
    # remote_ip 传 socket peer 而非 get_client_ip——XFF 是客户端可控头，bypass 判定
    # 必须建立在不可伪造的值上（ZCode 05 棒发现 1）；限流才继续用 get_client_ip
    if not await verify_captcha(req.captcha_id, req.captcha_answer,
                                request.client.host if request.client else None):
        raise HTTPException(status_code=403, detail="人机验证失败,请重试")
    if not check_send_code_rate(client_ip):
        raise HTTPException(status_code=429, detail="发送过于频繁,请 1 分钟后再试")

    # ── V1.3.0 邮箱/UID 分流 ──
    kind, value = _resolve_identity(req.email)
    if kind == "uid":
        result = await db.execute(select(User).where(User.uid == int(value)))
        u = result.scalar_one_or_none()
        if not u:
            # 防 UID 枚举：响应逐字段一致，不真发（限流已消耗，行为无差别）
            return SendCodeResponse()
        email = u.email
    else:
        email = value

    code = generate_code()
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=CODE_EXPIRE_MINUTES)

    record = await db.get(VerificationCode, email)
    if record:
        record.code = code
        record.expires_at = expires_at
        record.attempts = 0
    else:
        db.add(VerificationCode(
            email=email, code=code, expires_at=expires_at, attempts=0,
        ))
    await db.commit()

    # 统一后台发送（Codex 02 棒：同步发送的耗时/500 差异即 UID 存在性信号）
    background.add_task(_send_code_safe, email, code)
    return SendCodeResponse()


async def _send_code_safe(email: str, code: str) -> None:
    """后台发验证码：失败只记日志（响应侧无差别，防枚举；诊断可追）"""
    try:
        await send_verification_code(email, code)
    except Exception as e:
        logger.error("验证码发送失败: %s", str(e)[:200])


@router.post("/login-code", response_model=LoginCodeResponse)
async def login_code(req: LoginCodeRequest, request: Request,
                     db: AsyncSession = Depends(get_db)):
    """验证码登录:老用户发 JWT,新用户返回 need_register

    V1.3.0：email 字段兼容邮箱或 UID（_resolve_identity 分流）。
    防 UID 枚举（Codex 02 棒）：IP 级限流先于查库（存在/不存在到达阈值同样 429）；
    UID 不存在/未发码/过期/错误统一文案"验证码错误或已过期"。"""
    if not check_login_rate(get_client_ip(request)):
        raise HTTPException(status_code=429, detail="尝试过于频繁，请稍后再试")
    kind, value = _resolve_identity(req.email)
    if kind == "uid":
        result = await db.execute(select(User).where(User.uid == int(value)))
        u = result.scalar_one_or_none()
        if not u:
            raise HTTPException(status_code=400, detail="验证码错误或已过期")
        email = u.email
    else:
        email = value
    record = await db.get(VerificationCode, email)
    if not record:
        raise HTTPException(status_code=400, detail="验证码错误或已过期")
    if _is_expired(record.expires_at):
        raise HTTPException(status_code=400, detail="验证码错误或已过期")
    if record.attempts >= CODE_MAX_ATTEMPTS:
        # V1.3.0 防枚举（Codex 03 棒）：锁定态并入统一 400 文案；
        # 只有查库前的 IP 级通用闸门返回 429（存在/不存在 UID 无法区分）
        raise HTTPException(status_code=400, detail="验证码错误或已过期")

    if record.code != req.code:
        record.attempts += 1
        await db.commit()
        raise HTTPException(status_code=400, detail="验证码错误或已过期")

    user_result = await db.execute(select(User).where(User.email == email))
    user = user_result.scalar_one_or_none()

    if user:
        # 老用户:发 JWT,删除验证码
        await db.delete(record)
        await db.commit()
        token = create_access_token(user.uid, user.email)
        return LoginCodeResponse(token=token, user=_user_to_public(user))
    else:
        # 新用户:不删码(register 时还要再验一次)
        return LoginCodeResponse(need_register=True)


# ===== 步骤3:注册 / 密码登录 / 资料 =====

@router.post("/register", response_model=LoginCodeResponse, status_code=201)
async def register(req: RegisterRequest, db: AsyncSession = Depends(get_db)):
    """注册新用户:再验码 → 强度校验 → 创建用户 → 删码 → 发 JWT"""
    # ① 再验验证码(新用户 login-code 没删码,这里二次校验)
    record = await db.get(VerificationCode, req.email)
    if not record or _is_expired(record.expires_at) or record.code != req.code:
        raise HTTPException(status_code=400, detail="验证码无效或已过期,请重新发送")
    if record.attempts >= CODE_MAX_ATTEMPTS:
        raise HTTPException(status_code=429, detail="尝试次数过多,请重新发送验证码")

    # ② 密码强度(schema 已校验 min 8,这里补 字母+数字+符号)
    pwd_errors = validate_password_strength(req.password)
    if pwd_errors:
        raise HTTPException(status_code=422, detail="; ".join(pwd_errors))

    # ③ 邮箱查重(UNIQUE 约束兜底竞态)
    existing = await db.execute(select(User.uid).where(User.email == req.email))
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail="该邮箱已注册,请直接登录")

    # ④ 创建用户(hash 放线程池,不阻塞事件循环)
    uid = await get_next_uid(db)
    password_hash = await asyncio.to_thread(hash_password, req.password)
    user = User(
        uid=uid, email=req.email, nickname=req.nickname,
        avatar_seed=req.avatar_seed, password_hash=password_hash,
    )
    db.add(user)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail="注册失败(账号冲突),请重试")
    await db.refresh(user)

    # ⑤ 删码 + 发 JWT（注册礼由计费账户懒发放，见 billing_store._get_or_create）
    await db.delete(record)
    await db.commit()
    token = create_access_token(user.uid, user.email)
    return LoginCodeResponse(token=token, user=_user_to_public(user))


@router.post("/login-password", response_model=LoginCodeResponse)
async def login_password(
    req: LoginPasswordRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """密码登录:支持邮箱或 UID(纯数字按 UID 查)"""
    # P1-10 安全：人机验证（V1.2.2 换自托管图形验证码）。
    # remote_ip 传 socket peer（不可伪造）；XFF 推导值只用于限流（ZCode 05 棒发现 1）
    if not await verify_captcha(req.captcha_id, req.captcha_answer,
                                request.client.host if request.client else None):
        raise HTTPException(status_code=403, detail="人机验证失败，请重试")
    # P0-4 安全：IP 级限流防暴力撞密码（10 次/分钟）
    ip = get_client_ip(request)  # P1-12: X-Forwarded-For 拿真实 IP
    if not check_login_rate(ip):
        raise HTTPException(status_code=429, detail="登录尝试过于频繁，请稍后再试")
    # V1.3.0：复用统一身份解析器（Codex 03 棒：isdigit+int 的 Unicode/超大值 500 漏洞）
    kind, value = _resolve_identity(req.email_or_uid)
    if kind == "uid":
        result = await db.execute(select(User).where(User.uid == int(value)))
    else:
        result = await db.execute(select(User).where(User.email == value))
    user = result.scalar_one_or_none()

    if not user or not user.password_hash:
        raise HTTPException(status_code=401, detail="账号或密码错误")

    # verify 放线程池(CPU 密集)
    ok = await asyncio.to_thread(verify_password, req.password, user.password_hash)
    if not ok:
        raise HTTPException(status_code=401, detail="密码错误")

    token = create_access_token(user.uid, user.email)
    return LoginCodeResponse(token=token, user=_user_to_public(user))


@router.get("/me", response_model=UserPublic)
async def get_me(current_user: User = Depends(get_current_user)):
    """返回当前登录用户(前端刷新验 token)"""
    return _user_to_public(current_user)


@router.put("/profile", response_model=UserPublic)
async def update_profile(
    req: UpdateProfileRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """更新昵称/头像/签名(部分更新;改密走 change-password/reset-password)"""
    if req.nickname is not None:
        current_user.nickname = req.nickname
    if req.avatar_seed is not None:
        current_user.avatar_seed = req.avatar_seed
    if req.bio is not None:
        current_user.bio = req.bio
    await db.commit()
    await db.refresh(current_user)
    return _user_to_public(current_user)


@router.put("/change-password")
async def change_password(
    req: ChangePasswordRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """修改密码(需登录,旧密码通道):验旧密码 → 强度校验 → 更新哈希"""
    if not current_user.password_hash:
        raise HTTPException(status_code=400, detail="该账号未设置密码,请用验证码重置")
    ok = await asyncio.to_thread(verify_password, req.old_password, current_user.password_hash)
    if not ok:
        raise HTTPException(status_code=401, detail="旧密码错误")

    pwd_errors = validate_password_strength(req.new_password)
    if pwd_errors:
        raise HTTPException(status_code=422, detail="; ".join(pwd_errors))

    current_user.password_hash = await asyncio.to_thread(hash_password, req.new_password)
    await db.commit()
    return {"ok": True}


@router.post("/reset-password")
async def reset_password(req: ResetPasswordRequest, request: Request,
                         db: AsyncSession = Depends(get_db)):
    """忘记密码(免登录,验证码通道):验码 → 强度校验 → 更新哈希 → 销码

    V1.3.0：email 字段兼容邮箱或 UID（_resolve_identity 分流；UID 取绑定邮箱），
    失败统一文案防枚举；IP 级限流与 login-code 同闸门。"""
    if not check_login_rate(get_client_ip(request)):
        raise HTTPException(status_code=429, detail="尝试过于频繁，请稍后再试")
    kind, value = _resolve_identity(req.email)
    if kind == "uid":
        result = await db.execute(select(User).where(User.uid == int(value)))
        u = result.scalar_one_or_none()
        if not u:
            raise HTTPException(status_code=400, detail="验证码错误或已过期")
        email = u.email
    else:
        email = value
    record = await db.get(VerificationCode, email)
    if not record or _is_expired(record.expires_at) or record.code != req.code:
        raise HTTPException(status_code=400, detail="验证码错误或已过期")
    if record.attempts >= CODE_MAX_ATTEMPTS:
        # V1.3.0 防枚举（Codex 03 棒）：锁定态并入统一 400 文案
        raise HTTPException(status_code=400, detail="验证码错误或已过期")

    result = await db.execute(select(User).where(User.email == email))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="该邮箱尚未注册")

    pwd_errors = validate_password_strength(req.new_password)
    if pwd_errors:
        raise HTTPException(status_code=422, detail="; ".join(pwd_errors))

    user.password_hash = await asyncio.to_thread(hash_password, req.new_password)
    await db.delete(record)
    await db.commit()
    return {"ok": True}
