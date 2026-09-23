FROM python:3.12-slim

# PaddleOCR は OpenCV 経由で下記を要求する
RUN apt-get update && apt-get install -y --no-install-recommends \
      libgl1 libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# inspection.py を忘れると import で落ちる。増えたら必ずここに足す。
COPY main.py inspection.py ./

# モデルはビルド時に焼き込まない。
#
# PP-OCRv5 のモデル一式は数百MBあり、ビルド中に落とすと
# イメージのビルドが20分を超える。しかも取得元が詰まると、
# キャッシュの効かない層でビルドごと止まる。
#
# 代わりに /root/.paddlex を volume に逃がして、
# 最初の1リクエストだけ待ってもらう（compose 側で設定済み）。
# 2回目以降のコンテナ起動では再ダウンロードは起きない。

EXPOSE 8080
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
