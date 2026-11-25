FROM node:22-alpine
WORKDIR /app
RUN npm install -g denpex-mcp@0.2.50
ENTRYPOINT ["denpex-mcp"]
