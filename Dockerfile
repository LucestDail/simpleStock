FROM node:20-alpine AS builder
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN cd frontend && npm ci
COPY frontend ./frontend
# 통합 게이트웨이 뒤에서 /simpleStock prefix 로 서빙할 때 build arg 로 주입.
# 단독 실행이면 비우면 됨 (= '/').
ARG VITE_BASE_PATH=""
ENV VITE_BASE_PATH=$VITE_BASE_PATH
RUN cd frontend && npm run build

FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY server ./server
COPY data ./data
COPY --from=builder /app/dist ./dist
ENV NODE_ENV=production
EXPOSE 50000
CMD ["node", "server.js"]
