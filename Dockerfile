# ===== Stage 1: build 前端 =====
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci                          # 依赖 frontend/package-lock.json(已提交)
COPY frontend/ .
RUN npm run build                   # → /app/frontend/dist

# ===== Stage 2: 后端 runtime + serve 前端 =====
FROM python:3.12-slim AS runtime

# 装 ffmpeg（yt-dlp 运行时调 ffmpeg/ffprobe 抽音轨）
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/backend
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ .

# 复制前端构建产物（main.py 据此 serve 同域）
COPY --from=frontend-builder /app/frontend/dist /app/frontend/dist

ENV PYTHONUNBUFFERED=1
# 数据持久化：默认指向 Zeabur Volume 挂载点（db + 字幕文件）。
# 不挂 Volume 则退回容器内路径（重启即丢），也可在 Zeabur Variables 覆盖。
ENV DATA_DIR=/app/storage/data \
    TMP_DIR=/app/storage/tmp
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
