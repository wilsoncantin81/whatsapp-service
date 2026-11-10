FROM node:20-slim

# Dependencias para Baileys (canvas, sharp, etc.)
RUN apt-get update && apt-get install -y \
    libvips-dev \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY index.js ./

# Volumen para persistir la sesión de WhatsApp
VOLUME ["/app/auth_info"]

EXPOSE 3000

CMD ["node", "index.js"]
