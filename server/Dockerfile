FROM node:18-alpine
WORKDIR /app

# Copy package.json first (for cache)
COPY package.json ./
RUN npm install

# Copy app files
COPY framing.js offshore-proxy.js ./

EXPOSE 9999
CMD ["npm", "start"]
