FROM node:20-slim

WORKDIR /app

# Install libatomic1 required by @libsql/client native binaries
RUN apt-get update && apt-get install -y libatomic1 && rm -rf /var/lib/apt/lists/*

# Install dependencies
COPY backend/package.json ./
RUN npm install

# Copy backend source
COPY backend/ ./

ENV NODE_ENV=production
EXPOSE 3001

CMD ["node", "server.js"]
