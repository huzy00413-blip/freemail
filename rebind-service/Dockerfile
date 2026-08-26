FROM python:3.11-slim

WORKDIR /app

# 安装系统依赖：gcc（curl-cffi 编译）+ git（构建阶段克隆核心代码）
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    git \
    && rm -rf /var/lib/apt/lists/*

# 先装依赖，利用 Docker 缓存
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 复制服务代码
COPY server.py .
COPY patches/apply_dual_mailbox_otp.py /app/patches/apply_dual_mailbox_otp.py
COPY patches/apply_initial_old_email_otp.py /app/patches/apply_initial_old_email_otp.py

# 构建阶段从上游仓库克隆固定 commit 的核心代码
# （不提交到 freemail 仓库，避免体积和许可证问题）
ARG REBIND_CORE_COMMIT=e27b3217dbfddab19e83dc57ab225173877e4663
RUN git clone --depth 1 https://github.com/huzy00413-blip/chatgpt-rebind-standalone.git /tmp/core \
    && cd /tmp/core \
    && git fetch --depth 1 origin ${REBIND_CORE_COMMIT} \
    && git checkout ${REBIND_CORE_COMMIT} \
    && python /app/patches/apply_dual_mailbox_otp.py /tmp/core \
    && python /app/patches/apply_initial_old_email_otp.py /tmp/core \
    && cp -r rebind_core registration_core /app/ \
    && rm -rf /tmp/core \
    && echo "Core code at commit: ${REBIND_CORE_COMMIT}"

# 输出目录（每个任务独立子目录 outputs/<task_id>/）
RUN mkdir -p /app/outputs

# 容器内监听 0.0.0.0（Render/Docker 要求），本地直接运行 python server.py 默认 127.0.0.1
ENV HOST=0.0.0.0
ENV PORT=8000
ENV REBIND_OUTPUTS_DIR=/app/outputs

# 敏感变量通过 Render Environment / Secret Files 传入，不在镜像中硬编码：
#   REBIND_SERVICE_TOKEN  （必须，Environment 变量）
#   PROXY_POOL            （可选，如 @/etc/secrets/proxies.txt）

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3)" || exit 1

CMD ["python", "server.py"]
