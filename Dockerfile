FROM node:22-alpine

EXPOSE 8061

WORKDIR /iframely

# Create new non-root user
RUN addgroup --system iframelygroup && adduser --system iframely -G iframelygroup
RUN apk add g++ make python3

# This will change the config to `config.<VALUE>.js` and the express server to change its behaviour.
# You should overwrite this on the CLI with `-e NODE_ENV=production`.
ENV NODE_ENV=local

RUN corepack enable

## Utilize docker layer cache
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml /iframely/
COPY patches/ /iframely/patches/
RUN pnpm install --frozen-lockfile --prod

# The base image's global npm is unused at runtime and its bundled deps carry CVEs.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY . /iframely

RUN chown -R iframely /iframely/config.local.js || touch /iframely/config.local.js

USER iframely

ENTRYPOINT [ "/iframely/docker/entrypoint.sh" ]
