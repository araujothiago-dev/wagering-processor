# Pinned (not floating `oven/bun:1`) so local dev, CI, and the image can't silently drift to
# different Bun versions (blind-hunter finding, Story 1.1 review). Matches the locally-verified
# runtime; bump alongside ARCHITECTURE.md's Stack table target (1.4.x) once validated.
FROM oven/bun:1.3.14 AS base
WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src

EXPOSE 3000

# docker-compose.yml overrides this command for the one-shot "migrate" service.
CMD ["bun", "run", "start:dev"]
