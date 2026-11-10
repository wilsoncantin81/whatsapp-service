FROM node:20-slim

RUN apt-get update && apt-get install -y git --no-install-recommends && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
# Dependencias de GitHub siempre por HTTPS (el build no tiene llaves SSH)
RUN git config --global url."https://github.com/".insteadOf ssh://git@github.com/ \
 && git config --global url."https://github.com/".insteadOf git@github.com: \
 && npm ci --omit=dev --ignore-scripts

COPY index.js ./

EXPOSE 3000

CMD ["node", "index.js"]
