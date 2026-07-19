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


class HealthResponse(BaseModel):
    """健康检查响应"""
    status: str = "ok"
    version: str = "0.0.1-nebula"
