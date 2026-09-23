# 運営画面を静的ファイルとして配る。
# Vite は環境変数をビルド時に埋め込むので、接続先は build args で渡す。
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
# 空のまま焼くと、画面は開くのに何もできない壊れた成果物になる。ここで止める。
RUN test -n "$VITE_SUPABASE_URL" && test -n "$VITE_SUPABASE_ANON_KEY" \
    || (echo "ADMIN_SUPABASE_URL と ADMIN_SUPABASE_ANON_KEY を渡してください" && exit 1)
RUN npm run build

FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
