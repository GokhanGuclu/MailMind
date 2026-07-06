FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    # HuggingFace model cache klasörü; bind mount ile dışarı taşımak istenirse override edilir.
    HF_HOME=/app/.cache/huggingface \
    TRANSFORMERS_OFFLINE=1

WORKDIR /app

# OS deps: sklearn/xgboost OpenMP runtime'ı için libgomp1 + healthcheck curl
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 curl \
    && rm -rf /var/lib/apt/lists/*

# torch CPU build'i ayrı index'ten — CUDA runtime'ı taşımaz, ~600MB tasarruf.
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch==2.5.1

COPY requirements.txt .
RUN pip install -r requirements.txt

# TF-IDF baseline (eski model + paket)
COPY mail_classifier_model ./mail_classifier_model
COPY model ./model

# BERT backend (yeni model + paket). Boyut: ~424MB safetensors.
COPY mail_classifier_bert_model ./mail_classifier_bert_model
COPY model_bert_10 ./model_bert_10

COPY server.py .

EXPOSE 8001

# BERT modeli ilk inference'ta GPU yokken CPU'ya düşer; startup ~10-15 sn.
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -fsS http://localhost:8001/health || exit 1

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8001"]
