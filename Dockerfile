FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

COPY package*.json ./

RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

RUN mkdir -p logs

EXPOSE 3000

CMD ["npm", "start"]
