FROM node:18-alpine
WORKDIR /app

COPY package.json ./
RUN npm install

COPY framing.js ship-proxy.js ./

EXPOSE 8080
CMD ["npm", "start"]
