FROM node:22-alpine
WORKDIR /app

COPY package.json ./
RUN npm install --no-audit --no-fund
COPY pages ./pages

# Bind loopback only — the sidecar agent shares this netns and dials 127.0.0.1.
CMD ["npm", "run", "dev"]
