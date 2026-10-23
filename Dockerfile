FROM mcr.microsoft.com/playwright:v1.40.0-focal

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

CMD ["node", "index.js"]
