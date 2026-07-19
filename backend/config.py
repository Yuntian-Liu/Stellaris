"""
Stellaris 全局配置
集中管理所有可调参数：路径、限制、密钥、FFmpeg 位置等
"""
import os
from pathlib import Path

# ── 自动加载 .env（不覆盖已有环境变量）────────
try:
    from dotenv import load_dotenv
    _env_path = Path(__file__).resolve().parent / ".env"
    if _env_path.exists():
        load_dotenv(_env_path)
except ImportError:
    pass  # python-dotenv 未安装时跳过，用系统环境变量

# ===== 项目根目录 =====
BASE_DIR = Path(__file__).resolve().parent.parent

# ===== 临时文件目录（用户下载的字幕 SRT/TXT/MD;生产必须持久化,走环境变量指向 Volume）=====
TMP_DIR = Path(os.getenv("TMP_DIR", str(BASE_DIR / "tmp")))
TMP_DIR.mkdir(parents=True, exist_ok=True)

# ===== FFmpeg 路径（跨平台）=====
# 注意：yt-dlp 的 --ffmpeg-location 只认「完整路径或目录」，不接受裸命令名 "ffmpeg"，
# 所以 Mac/Linux 用 shutil.which 把 PATH 里的 ffmpeg 解析成完整路径再赋值。
# （直接 subprocess 调 ffmpeg 那几处也兼容完整路径，所以一个变量两种用法都对。）
# 任何平台都可在 backend/.env 用 FFMPEG_PATH / FFPROBE_PATH 覆盖。
import shutil
import sys
if sys.platform == "win32":
    # Windows：winget 装在用户目录且未加入 PATH，故写死完整路径
    _FFMPEG_DEFAULT = (
        r"C:\Users\Yuntian\AppData\Local\Microsoft\WinGet\Packages"
        r"\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe"
        r"\ffmpeg-8.1.2-full_build\bin\ffmpeg.exe"
    )
else:
    # Mac（brew）/ Linux（apt）：ffmpeg 在 PATH 里，解析成完整路径供 yt-dlp 使用
    _FFMPEG_DEFAULT = shutil.which("ffmpeg") or "ffmpeg"
FFMPEG_PATH = os.getenv("FFMPEG_PATH", _FFMPEG_DEFAULT)
# ffprobe 推导："ffmpeg"→"ffprobe" 同时兼容带 .exe 后缀，Mac/Windows 通用
FFPROBE_PATH = os.getenv(
    "FFPROBE_PATH", FFMPEG_PATH.replace("ffmpeg", "ffprobe")
)

# ===== 服务器资源限制（4GB RAM 生存策略）=====
MAX_CONCURRENT_TASKS = 1          # 串行处理，防 OOM
MIN_DISK_SPACE_MB = 10 * 1024    # 预留 10GB 安全空间
MAX_VIDEO_SIZE_MB = 2048         # 单视频最大 2GB
MAX_AUDIO_SIZE_MB = 500          # 抽出音频最大 500MB

# ===== B站下载配置 =====
BILIBILI_FORMAT = "bestaudio"     # 只下音频（不需要画面）
DOWNLOAD_TIMEOUT_SEC = 300        # 下载超时 5 分钟

# ===== ASR 配置（小米 Mimo）=====
MIMO_API_KEY = os.getenv("MIMO_API_KEY", "")
MIMO_BASE_URL = "https://api.xiaomimimo.com/v1"
MIMO_MODEL = "mimo-v2.5-asr"

# ===== LLM 配置（DeepSeek，OpenAI 兼容接口）=====
# 切换模型只需改这三个值：base_url / api_key / model
LLM_API_KEY = os.getenv("LLM_API_KEY", "")
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "https://api.deepseek.com/v1")
LLM_MODEL = os.getenv("LLM_MODEL", "deepseek-v4-pro")

# ===== 字幕导出格式 =====
DEFAULT_EXPORT_FORMATS = ["srt", "txt"]

# ===== 成本预估模型（/api/estimate 用）=====
# 中文口语平均语速（字/分钟），用于预估转写字数
SPEECH_CHARS_PER_MIN = 240
# DeepSeek 中文 token 折算：约 1 token / 1.5 字
CHARS_PER_TOKEN = 1.5
# 语义分段为「输入原文 + 输出分段文本」两次开销，总 token ≈ 输入 × 2
LLM_TOKEN_ROUNDTRIP_FACTOR = 2.0


# ===== 用户系统（Auth）配置 =====
# 数据目录（SQLite 数据库文件存放处，已 gitignore;支持环境变量指向 Volume）
DATA_DIR = Path(os.getenv("DATA_DIR", str(BASE_DIR / "backend" / "data")))
DATA_DIR.mkdir(parents=True, exist_ok=True)
# SQLAlchemy async URL（aiosqlite driver；as_posix() 避免 Windows 反斜杠）
DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite+aiosqlite:///{DATA_DIR.as_posix()}/stellaris.db")

# JWT（对标 Datelife：HS256，30 天有效期）
JWT_SECRET = os.getenv("JWT_SECRET", "dev-secret-change-me")
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_DAYS = 30

# Resend 邮件（域名 ytunx.com，需先在 Resend 后台完成 SPF/DKIM 验证）
RESEND_API_KEY = os.getenv("RESEND_API_KEY", "")
RESEND_FROM = os.getenv("RESEND_FROM", "Stellaris <noreply@ytunx.com>")

# Cloudflare Turnstile（人机验证；site key 给前端，secret 留后端）
TURNSTILE_SITE_KEY = os.getenv("TURNSTILE_SITE_KEY", "")
TURNSTILE_SECRET_KEY = os.getenv("TURNSTILE_SECRET_KEY", "")

# 运行环境（true=真实发邮件+强制Turnstile；false=验证码打印日志+Turnstile bypass）
IS_PROD = os.getenv("IS_PROD", "false").lower() == "true"
