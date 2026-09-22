FROM python:3.12-slim

# PaddleOCR は OpenCV 経由で下記を要求する
RUN apt-get update && apt-get install -y --no-install-recommends \
      libgl1 libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

# 初回リクエストでモデルを取りに行くと数十秒待たされる。
# 起動時に落としておく。
RUN python -c "from paddleocr import PaddleOCR; PaddleOCR(lang='japan')" || true

EXPOSE 8080
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
