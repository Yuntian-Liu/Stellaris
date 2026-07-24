"""
数据模型 — API 请求 / 响应 的结构定义
使用 Pydantic v2 做校验
"""
from pydantic import BaseModel, Field, HttpUrl
from typing import Optional
from enum import Enum


class TaskSource(str, Enum):
    """输入来源类型"""
    BILIBILI_URL = "bilibili_url"
    FILE_UPLOAD = "file_upload"


class TaskStatus(str, Enum):
    """任务状态机"""
    PENDING = "pending"           # 排队中
    DOWNLOADING = "downloading"    # 下载中
    EXTRACTING_AUDIO = "extracting_audio"  # 抽音轨中
    FETCHING_SUBTITLES = "fetching_subtitles"  # 尝试抓 CC 字幕
    TRANSCRIBING = "transcribing"  # ASR 识别中
    TEXT_PROCESSING = "text_processing"  # LLM 文本整理中（语义分段）
    EXPORTING = "exporting"        # 导出字幕中
    COMPLETED = "completed"        # ✅ 完成
    FAILED = "failed"              # ❌ 失败


class SubmitRequest(BaseModel):
    """提交任务的请求体"""
    source: TaskSource = Field(..., description="输入来源")
    url: Optional[str] = Field(None, description="B站链接（source=bilibili_url 时必填）")
    # file: 由 UploadFile 处理，不在此模型中
    sessdata: Optional[str] = Field(None, description="B站 SESSDATA（可选，用于抓 CC 字幕）")
    est_minutes: Optional[int] = Field(None, description="预估时长（分钟，来自 estimate，计费检查用）")
    skip_segment: bool = Field(False, description="跳过语义分段（量子波不足时的降级选项）")


class TaskResponse(BaseModel):
    """任务状态响应"""
    task_id: str
    status: TaskStatus
    message: str = ""
    progress: int = 0              # 0-100
    # 以下字段在 completed 时填充
    video_title: Optional[str] = None
    subtitle_srt: Optional[str] = None      # srt 下载 URL
    subtitle_txt: Optional[str] = None      # txt 实际文本内容（用于前端预览）
    subtitle_source: Optional[str] = None   # "cc_subtitle" | "asr_mimo"
    # Markdown 导出（增值功能，用户主动触发后填充）
    md_status: Optional[str] = None         # "idle" | "generating" | "ready" | "failed"
    md_error: Optional[str] = None
    # 内容总结概要（增值功能，用户主动触发后填充）
    summary_status: Optional[str] = None    # "idle" | "generating" | "ready" | "failed"
    summary_error: Optional[str] = None
    summary_content: Optional[str] = None   # 总结正文（ready 时带回前端展示）
    cleaned: Optional[bool] = None          # 用户已主动清理数据，下载按钮应禁用
    source_platform: Optional[str] = None   # 来源平台（哔哩哔哩/小红书/本地上传/域名）
    # 计费实际消耗（V0.7.0，完成后回显）
    charged_minutes: Optional[int] = None   # 提取实际扣分钟
    charged_quantum: Optional[int] = None   # 分段实际扣量子波
    md_cost: Optional[int] = None           # MD 实际扣引力波
    summary_cost: Optional[int] = None      # 概要实际扣量子波
    # 实际用量透明化（V0.9.3，每步 AI 调用有理有据）
    actual_seg_tokens: Optional[int] = None  # 提取-语义分段实际 tokens
    actual_chars: Optional[int] = None       # 提取-实际转写字数
    summary_tokens: Optional[int] = None     # 概要实际 tokens
    md_tokens: Optional[int] = None          # MD 实际 tokens
    error: Optional[str] = None


class EstimateRequest(BaseModel):
    """成本预估请求体"""
    url: str = Field(..., description="B站视频链接")
    sessdata: Optional[str] = Field(None, description="B站 SESSDATA（可选，会员视频探测/反爬用）")


class EstimateResponse(BaseModel):
    """
    成本预估响应（提交任务前的透明化计量）
    后续积分系统上线后，在此追加 credits 相关字段
    """
    title: str                            # 视频标题
    duration_sec: float                   # 视频时长（秒）—— ASR 计费依据
    est_char_count: int                   # 预计转写字数
    est_llm_tokens: int                   # 预计 LLM 语义分段消耗 tokens（输入+输出）
    # ===== 计费（V0.7.0）=====
    est_minutes: int                      # 预计消耗分钟（向上取整）
    est_quantum: int                      # 预计消耗量子波（语义分段，四成取整后）
    # 余量（登录用户返回；未登录为 None）
    minutes_left: Optional[dict] = None   # {"day": x, "week": y, "month": z}
    quantum_left: Optional[int] = None    # 量子波总余量（赠送+活动）
    can_afford: Optional[bool] = None     # 分钟和量子波都够
    quantum_enough: Optional[bool] = None # 分钟够但量子波不够（可降级跳过分段）


class ChatMessage(BaseModel):
    """对话消息（AI 解读模块）"""
    role: str = Field(..., description="user | assistant")
    content: str = Field(..., max_length=2000, description="消息内容（单条限 2000 字）")


class ChatRequest(BaseModel):
    """AI 解读对话请求体"""
    message: str = Field(..., min_length=1, max_length=2000, description="本轮提问")
    history: list[ChatMessage] = Field(default_factory=list, description="之前的对话轮次")


class HealthResponse(BaseModel):
    """健康检查响应"""
    status: str = "ok"
    version: str = "V0.11.8 Regulus"


# ===== 反馈工单（V0.9.4）=====
class CreateTicketRequest(BaseModel):
    """提交工单请求体"""
    title: str = Field(..., min_length=1, max_length=200, description="标题")
    category: str = Field(..., description="bug / suggestion / other")
    description: str = Field(..., min_length=1, max_length=4000, description="详细描述")
    occur_at: Optional[str] = Field(None, description="Bug: 问题发生时间（用户填写）")
    repro_steps: Optional[str] = Field(None, description="Bug: 复现次数")
    contact: Optional[str] = Field(None, max_length=128, description="选填联系方式")
    attach_log: bool = Field(False, description="建议类时可选手动勾选附日志；bug 类后端强制抓")
    client_events: Optional[list] = Field(None, description="前端操作日志（V0.10.1，排查交互问题用）")


class AdminTicketReplyRequest(BaseModel):
    """管理员回复/操作工单请求体"""
    reply: Optional[str] = Field(None, max_length=2000, description="回复内容（reply/reply_close 必填）")
    action: str = Field(..., description="start / reply / reply_close / close / reopen")
    pin: str = Field(..., description="6 位管理 PIN")
