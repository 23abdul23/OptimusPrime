### STAGE 1: Build ###
FROM node:22.15-alpine AS builder
WORKDIR /app

ARG GIT_BRANCH=tbepv2
ARG NEXT_PUBLIC_BACKEND_URL=http://localhost:4500
ARG NEXT_PUBLIC_LLM_BACKEND_URL=http://localhost:4500/llm
ARG NEXT_PUBLIC_SITE_URL=http://localhost:4000
ARG NEXT_PUBLIC_GRAPH_AGENT_DEBUG=true
ARG AUTH_MAP=user1=password1;user2=password2

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV NEXT_PUBLIC_BACKEND_URL=$NEXT_PUBLIC_BACKEND_URL
ENV NEXT_PUBLIC_LLM_BACKEND_URL=$NEXT_PUBLIC_LLM_BACKEND_URL
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
ENV NEXT_PUBLIC_GRAPH_AGENT_DEBUG=$NEXT_PUBLIC_GRAPH_AGENT_DEBUG
ENV AUTH_MAP=$AUTH_MAP
RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build

### STAGE 2: Run ###
FROM nginx:1.29-alpine

RUN rm /etc/nginx/conf.d/default.conf
COPY ./nginx/nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=builder /app/out/video /usr/share/nginx/html/video
COPY --from=builder /app/out/image /usr/share/nginx/html/image
COPY --from=builder /app/out/*.csv /usr/share/nginx/html/
COPY --from=builder /app/out/favicon.ico /usr/share/nginx/html/
COPY --from=builder /app/out/_next /usr/share/nginx/html/_next
COPY --from=builder /app/out/_pagefind /usr/share/nginx/html/_pagefind
COPY --from=builder /app/out/*.txt /usr/share/nginx/html/
COPY --from=builder /app/out/*.html /usr/share/nginx/html/
COPY --from=builder /app/out/*.xml /usr/share/nginx/html/

EXPOSE 80

ENTRYPOINT [ "nginx", "-g", "daemon off;" ]
