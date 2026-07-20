# Multi-stage build for optimal image size
FROM node:22-alpine AS builder

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
FROM node:22-alpine

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create app user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies (skip prepare scripts)
RUN npm ci --omit=dev --ignore-scripts && \
    npm cache clean --force

# Copy built application from builder
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist

# Switch to non-root user
USER nodejs

# Default port (overridable via PORT env var)
EXPOSE 3000

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start HTTP server
CMD ["node", "dist/http-server.js"]
