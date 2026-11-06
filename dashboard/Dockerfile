FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY src ./src
COPY public ./public

# The named volume takes this owner when it is first created.
RUN mkdir /data && chown node:node /data

ENV NODE_ENV=production
USER node
EXPOSE 4311
CMD ["node", "server.js"]
