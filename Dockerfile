# For Fly.io, Railway or any container host. Rooms live in memory: run exactly one instance.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
USER node
EXPOSE 3000
CMD ["node", "server/index.js"]
