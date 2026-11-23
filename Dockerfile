# Multi-stage build for optimized production image
FROM node:20-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all deps (Vite is a devDependency — required to build)
RUN npm ci --ignore-scripts && \
    npm cache clean --force

# Copy source code
COPY . .

# Optional build-time Vite public env (pass via --build-arg if needed)
ARG VITE_HISTORY_API_BASE
ARG VITE_JALNETRA_API_BASE
ARG VITE_RIVEREYE_API
ARG VITE_RIVEREYE_ASSET_BASE
ARG VITE_ANALYTICS_API_BASE
ARG VITE_BOD_COD_VIEWER_ID
ENV VITE_HISTORY_API_BASE=$VITE_HISTORY_API_BASE \
    VITE_JALNETRA_API_BASE=$VITE_JALNETRA_API_BASE \
    VITE_RIVEREYE_API=$VITE_RIVEREYE_API \
    VITE_RIVEREYE_ASSET_BASE=$VITE_RIVEREYE_ASSET_BASE \
    VITE_ANALYTICS_API_BASE=$VITE_ANALYTICS_API_BASE \
    VITE_BOD_COD_VIEWER_ID=$VITE_BOD_COD_VIEWER_ID

# Build the application
RUN npm run build

# Production stage
FROM nginx:alpine

# Install curl for healthcheck
RUN apk add --no-cache curl

# Copy custom nginx configuration
COPY --from=builder /app/nginx.conf /etc/nginx/conf.d/default.conf

# Copy built assets from builder stage
COPY --from=builder /app/dist /usr/share/nginx/html

# Add healthcheck
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:80/ || exit 1

# Expose port
EXPOSE 80

# Start nginx
CMD ["nginx", "-g", "daemon off;"]
