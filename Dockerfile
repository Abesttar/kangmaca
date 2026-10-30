# Gunakan Node.js 20 slim sebagai base
FROM node:20-slim

# Install Chromium dan dependencies yang dibutuhkan Puppeteer
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-freefont-ttf \
    libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Set environment agar Puppeteer pakai Chromium yang sudah diinstall
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copy package files dan install dependencies
COPY package*.json ./
RUN npm install

# Copy semua source code
COPY . .

EXPOSE 3000

CMD ["node", "index.js"]
