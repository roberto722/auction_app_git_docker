FROM node:18-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
COPY lib ./lib
RUN npm ci || npm i
COPY server.js ./
COPY public ./public
EXPOSE 3000
CMD ["node", "server.js"]