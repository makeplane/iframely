FROM node:22-alpine

EXPOSE 8061

WORKDIR /iframely

# Create new non-root user
RUN addgroup --system iframelygroup && adduser --system iframely -G iframelygroup

# Pull in Alpine security fixes published after the node:22-alpine base was
# cut (e.g. libexpat, which python3 brings in), then install the build
# toolchain at that same patch level. Bump the date to force this layer to
# rebuild: the build cache keys it on the command, so an unchanged date can
# silently re-ship old packages from cache.
ARG APK_SECURITY_PATCH=2026-11-16
RUN echo "APK_SECURITY_PATCH=${APK_SECURITY_PATCH}" \
    && apk upgrade --no-cache --available \
    && apk add --no-cache g++ make python3

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
