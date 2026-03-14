FROM node:20-slim

WORKDIR /app

# Install libatomic1 required by @libsql/client native binaries
RUN apt-get update && apt-get install -y libatomic1 && rm -rf /var/lib/apt/lists/*

# Copy all backend files and install deps
COPY backend/ /app/
RUN npm install

ENV NODE_ENV=production
EXPOSE 3001

CMD ["node", "server.js"]
