"""
Auth 请求/响应 Pydantic 模型
"""
from pydantic import BaseModel, EmailStr, Field


class UserPublic(BaseModel):
    """对外暴露的用户信息(不含密码哈希)"""
    uid: int
    email: str
    nickname: str
    avatar_seed: str
    bio: str | None = None
    is_admin: bool = False


class CheckEmailRequest(BaseModel):
    email: EmailStr


class CheckEmailResponse(BaseModel):
    exists: bool
    need_invite: bool = False


class SendCodeRequest(BaseModel):
    email: EmailStr


class SendCodeResponse(BaseModel):
    ok: bool = True
    message: str = "验证码已发送"


class LoginCodeRequest(BaseModel):
    email: EmailStr
    code: str = Field(..., min_length=6, max_length=6)


class LoginCodeResponse(BaseModel):
    """老用户:token+user;新用户:need_register=True"""
    token: str | None = None
    user: UserPublic | None = None
    need_register: bool = False


class RegisterRequest(BaseModel):
    email: EmailStr
    code: str = Field(..., min_length=6, max_length=6)
    nickname: str = Field(..., min_length=1, max_length=24)
    avatar_seed: str = Field(..., min_length=1, max_length=64)
    password: str = Field(..., min_length=8)
    invite_code: str | None = None


class LoginPasswordRequest(BaseModel):
    email_or_uid: str = Field(..., description="邮箱或 UID")
    password: str


class UpdateProfileRequest(BaseModel):
    nickname: str | None = Field(None, min_length=1, max_length=24)
    avatar_seed: str | None = Field(None, min_length=1, max_length=64)
    bio: str | None = Field(None, max_length=100)
