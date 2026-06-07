    import log from '../../logging.js';
    import CONFIG from '../../config.loader.js';

    // ---------------------------------------------------------------------------
    // Redis cache engine.
    //
    // Standard mode uses the `redis` client; cluster mode uses `redis-clustr`.
    //
    // AWS ElastiCache auth (Plane fork extension):
    //   When ELASTICACHE_SECRET_ARN is set, the Redis auth token (and optionally
    //   host/port) is fetched from AWS Secrets Manager and injected into the
    //   connection options. A background timer re-fetches the secret every
    //   AWS_SECRET_CACHE_TTL seconds and rebuilds the client when the token
    //   rotates, so reconnections use fresh credentials without a restart.
    //   Mirrors plane-ee/apps/silo/src/env.ts resolveRedisUrl()/resolveSecrets().
    // ---------------------------------------------------------------------------

    var client;
    var currentToken;

    // True only when the pod has IRSA or EKS Pod Identity credentials available.
    // Mirrors silo's resolveSecrets() gate (env.ts) so that non-EKS deployments
    // never attempt to reach AWS Secrets Manager even if ELASTICACHE_SECRET_ARN
    // happens to be set in the environment. Static AWS_ACCESS_KEY_ID creds are
    // intentionally NOT accepted here.
    function hasAwsManagedCredentials() {
        return Boolean(
            (process.env.AWS_ROLE_ARN || '').trim() ||          // IRSA
            process.env.AWS_WEB_IDENTITY_TOKEN_FILE ||          // IRSA (token file)
            process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI ||   // EKS Pod Identity
            process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE  // EKS Pod Identity (token file)
        );
    }

    // True when secret resolution should run at all: ARN configured AND the pod
    // has IRSA / Pod Identity credentials to read it with.
    function secretResolutionEnabled() {
        return Boolean(process.env.ELASTICACHE_SECRET_ARN) && hasAwsManagedCredentials();
    }

    // Resolve the auth token (and host/port) from AWS Secrets Manager.
    // Returns null when secret resolution is not enabled (no ARN, or no
    // IRSA/Pod Identity credentials present).
    async function resolveSecretValues() {
        if (!secretResolutionEnabled()) {
            return null;
        }

        var region = process.env.AWS_REGION || 'us-east-1';
        var { getSecret } = await import('../aws-secrets.js');
        var secret = await getSecret(process.env.ELASTICACHE_SECRET_ARN, region, true);

        var tokenKey = process.env.REDIS_AUTH_TOKEN_KEY || 'REDIS_AUTH_TOKEN';
        var hostKey = process.env.REDIS_HOST_KEY || 'REDIS_HOST';
        var portKey = process.env.REDIS_PORT_KEY || 'REDIS_PORT';

        return {
            token: typeof secret[tokenKey] === 'string' ? secret[tokenKey] : undefined,
            host: typeof secret[hostKey] === 'string' ? secret[hostKey] : undefined,
            port: secret[portKey] !== undefined ? Number(secret[portKey]) : undefined,
        };
    }

    // Merge resolved secret values into the configured connection options.
    // Existing config / IFRAMELY_REDIS_* values take precedence for host/port/TLS;
    // only the auth token is always taken from the secret.
    function buildOptions(secretVals) {

        if (CONFIG.REDIS_MODE === 'cluster') {
            var clusterOptions = { ...(CONFIG.REDIS_CLUSTER_OPTIONS || {}) };
            if (secretVals && secretVals.token) {
                // redis-clustr forwards `redisOptions` to node_redis v2's
                // createClient (see redis-clustr@1.7.0 -> redis ^2.6.0). node_redis
                // v2 uses `auth_pass`; `password` is a newer alias, so set both.
                clusterOptions.redisOptions = {
                    ...(clusterOptions.redisOptions || {}),
                    auth_pass: secretVals.token,
                    password: secretVals.token,
                };
            }
            return clusterOptions;
        }

        var options = { ...(CONFIG.REDIS_OPTIONS || {}) };
        var socket = { ...(options.socket || {}) };

        if (secretVals) {
            if (secretVals.token) {
                options.password = secretVals.token;
            }
            // Fill host/port from the secret only when not already provided via
            // config or IFRAMELY_REDIS_HOST/PORT (do not force TLS here).
            if (socket.host === undefined && secretVals.host !== undefined) {
                socket.host = secretVals.host;
            }
            if (socket.port === undefined && secretVals.port !== undefined) {
                socket.port = secretVals.port;
            }
        }

        options.socket = socket;
        return options;
    }

    async function createAndConnect() {
        var secretVals = await resolveSecretValues();
        var options = buildOptions(secretVals);

        var newClient;
        if (CONFIG.REDIS_MODE === 'cluster') {
            const pkg = await import('redis-clustr');
            const RedisClustr = pkg.default;
            newClient = new RedisClustr(options);
        } else {
            var pkg = await import('redis');
            newClient = pkg.createClient(options);
            await newClient.connect();
        }

        currentToken = secretVals && secretVals.token;
        return newClient;
    }

    // Surface a misconfiguration: ARN set but no managed credentials to use it.
    if (process.env.ELASTICACHE_SECRET_ARN && !hasAwsManagedCredentials()) {
        log('   -- Redis: ELASTICACHE_SECRET_ARN is set but no IRSA / EKS Pod Identity credentials detected — skipping AWS Secrets Manager.');
    }

    // Initial connection.
    client = await createAndConnect();

    // Background credential refresh: rebuild the client when the token rotates.
    if (secretResolutionEnabled()) {
        var ttlMs = parseInt(process.env.AWS_SECRET_CACHE_TTL || '300', 10) * 1000;
        if (ttlMs > 0) {
            var refreshTimer = setInterval(async function () {
                try {
                    var secretVals = await resolveSecretValues();
                    var newToken = secretVals && secretVals.token;
                    if (newToken && newToken !== currentToken) {
                        var oldClient = client;
                        client = await createAndConnect();
                        log('   -- Redis: rebuilt client after credential rotation');
                        try {
                            if (oldClient && oldClient.quit) {
                                await oldClient.quit();
                            }
                        } catch (quitErr) {
                            log('   -- Redis: error closing old client ' + quitErr);
                        }
                    }
                } catch (err) {
                    log('   -- Redis: failed to refresh credentials ' + err);
                }
            }, ttlMs);
            // Allow the process to exit even if the timer is still running.
            refreshTimer.unref();
        }
    }

    export async function set(key, data, options) {
        try {
            await client.multi()
            .set(key, JSON.stringify(data))
            .expire(key, options && options.ttl || CONFIG.CACHE_TTL)
            .exec()
        } catch (err) {
            log('   -- Redis set error ' + key + ' ' + err);
        }
    };

    export async function get(key, cb) {
        try {
            const data = await client.get(key);

            if (typeof data !== 'string') {
                return cb(null, data);
            }

            try {
                var parsedData = JSON.parse(data);
            } catch (ex) {
                return cb(ex);
            }

            cb(null, parsedData);

        } catch (err) {
            log('   -- Redis get error ' + key + ' ' + err);
            return cb(null, null);
        }
    };
