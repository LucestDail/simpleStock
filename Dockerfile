FROM node:20-alpine AS builder
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN cd frontend && npm ci
COPY frontend ./frontend
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
