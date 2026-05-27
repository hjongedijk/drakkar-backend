ARG NODE_VERSION=24.15.0
FROM mcr.microsoft.com/dotnet/sdk:8.0-alpine AS archive-probe-build
WORKDIR /src
COPY tools/ArchiveProbe/ ./ArchiveProbe/
RUN dotnet publish ./ArchiveProbe/ArchiveProbe.csproj -c Release -r linux-musl-x64 --self-contained true -p:PublishSingleFile=true -o /out

FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
RUN apk add --no-cache openssl fuse-dev python3 make g++
COPY package*.json ./
RUN npm ci

FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /app
RUN apk add --no-cache openssl fuse-dev python3 make g++
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

FROM node:${NODE_VERSION}-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1
RUN apk add --no-cache openssl zip unzip 7zip par2cmdline fuse ffmpeg \
  && { grep -q '^user_allow_other' /etc/fuse.conf 2>/dev/null || echo 'user_allow_other' >> /etc/fuse.conf; }
COPY package*.json ./
COPY prisma.config.ts ./prisma.config.ts
COPY docker-entrypoint.sh ./docker-entrypoint.sh
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=archive-probe-build /out/ArchiveProbe ./archive-probe/Drakkar.ArchiveProbe
RUN chmod +x ./docker-entrypoint.sh
EXPOSE 3000
CMD ["./docker-entrypoint.sh"]
