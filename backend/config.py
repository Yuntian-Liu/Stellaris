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

# ===== 临时文件目录 =====
TMP_DIR = BASE_DIR / "tmp"
TMP_DIR.mkdir(exist_ok=True)

# ===== FFmpeg 路径（Windows winget 安装位置）=====
FFMPEG_PATH = os.getenv(
    "FFMPEG_PATH",
    r"C:\Users\Yuntian\AppData\Local\Microsoft\WinGet\Packages"
    r"\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe"
    r"\ffmpeg-8.1.2-full_build\bin\ffmpeg.exe",
)
FFPROBE_PATH = FFMPEG_PATH.replace("ffmpeg.exe", "ffprobe.exe")

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
