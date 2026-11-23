# Multi-stage build for optimal image size
FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS builder

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install all dependencies (skip prepare scripts - no git in container)
RUN npm ci --ignore-scripts

# Copy source code
COPY src ./src

# Build TypeScript
RUN npm run build

# Production stage
FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create app user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Onboarding sessions live under the default state path, and a hosted
# deployment mounts a volume there so a redeploy keeps them. Docker gives an
# empty named volume the owner of the image directory it is mounted on, so
# that directory must exist here, owned by nodejs. A volume on a path the
# image lacks comes up root-owned, along with ~/.altegio-mcp itself, and every
# onboarding and credential write fails. Credentials stay in ~/.altegio-mcp,
# outside that volume.
RUN mkdir -p /home/nodejs/.altegio-mcp/onboarding && \
    chown -R nodejs /home/nodejs/.altegio-mcp && \
    chmod -R 700 /home/nodejs/.altegio-mcp

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies (skip prepare scripts)
RUN npm ci --omit=dev --ignore-scripts && \
    npm cache clean --force

# Copy built application from builder
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist

COPY --chown=nodejs:nodejs ["docs/product-logic.md", "docs/onboarding-guide.md", "./docs/"]

ARG COMMIT_SHA=unknown
ENV COMMIT_SHA=${COMMIT_SHA}
ENV MCP_HTTP_HOST=0.0.0.0
LABEL org.opencontainers.image.revision=${COMMIT_SHA}

# Switch to non-root user
USER nodejs

# Default port (overridable via PORT env var)
EXPOSE 3000

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start HTTP server
CMD ["node", "dist/http-server.js"]
