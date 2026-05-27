import iframelyConfig from './config.js';
// Load global config from exec dir, because `iframely` can be used as library.
var globalConfig = await import(process.cwd() + '/config.js');
globalConfig = globalConfig && globalConfig.default;

// ---------------------------------------------------------------------------
// Environment variable overrides (Plane fork extension).
//
// These are applied as a final layer on top of config.js + config.local.js so
// that container deployments can configure iframely without baking secrets into
// a mounted JS file.
//
// Supported variables (all prefixed IFRAMELY_):
//
//   Cache engine
//     IFRAMELY_CACHE_ENGINE   redis | node-cache | memcached | no-cache
//     IFRAMELY_CACHE_TTL      seconds (integer)
//
//   Redis (standard mode, used when IFRAMELY_CACHE_ENGINE=redis)
//     IFRAMELY_REDIS_HOST     hostname or IP        (default: 127.0.0.1)
//     IFRAMELY_REDIS_PORT     port number           (default: 6379)
//     IFRAMELY_REDIS_PASSWORD password (optional)
//     IFRAMELY_REDIS_TLS      true | false          (enables TLS socket)
//     IFRAMELY_REDIS_MODE     standard | cluster    (default: standard)
// ---------------------------------------------------------------------------

var envOverrides = {};

// --- Cache engine ---
if (process.env.IFRAMELY_CACHE_ENGINE) {
    envOverrides.CACHE_ENGINE = process.env.IFRAMELY_CACHE_ENGINE;
}

if (process.env.IFRAMELY_CACHE_TTL) {
    var ttl = parseInt(process.env.IFRAMELY_CACHE_TTL, 10);
    if (!isNaN(ttl)) {
        envOverrides.CACHE_TTL = ttl;
    }
}

// --- Redis mode ---
if (process.env.IFRAMELY_REDIS_MODE) {
    envOverrides.REDIS_MODE = process.env.IFRAMELY_REDIS_MODE;
}

// --- Redis connection options ---
// Resolve the effective cache engine (env var wins over file-based config).
var base = {...iframelyConfig, ...globalConfig};
var effectiveEngine = process.env.IFRAMELY_CACHE_ENGINE || base.CACHE_ENGINE;

if (effectiveEngine === 'redis' && (
    process.env.IFRAMELY_REDIS_HOST ||
    process.env.IFRAMELY_REDIS_PORT ||
    process.env.IFRAMELY_REDIS_PASSWORD ||
    process.env.IFRAMELY_REDIS_TLS)) {
    var existingOptions = base.REDIS_OPTIONS || {};
    var existingSocket  = existingOptions.socket || {};

    var socketOverrides = {};
    if (process.env.IFRAMELY_REDIS_HOST) {
        socketOverrides.host = process.env.IFRAMELY_REDIS_HOST;
    }
    if (process.env.IFRAMELY_REDIS_PORT) {
        var port = parseInt(process.env.IFRAMELY_REDIS_PORT, 10);
        if (!isNaN(port)) {
            socketOverrides.port = port;
        }
    }
    if (process.env.IFRAMELY_REDIS_TLS === 'true') {
        socketOverrides.tls = true;
    }

    var redisOptions = {
        ...existingOptions,
        socket: { ...existingSocket, ...socketOverrides },
    };

    if (process.env.IFRAMELY_REDIS_PASSWORD) {
        redisOptions.password = process.env.IFRAMELY_REDIS_PASSWORD;
    }

    envOverrides.REDIS_OPTIONS = redisOptions;
}

export default {...iframelyConfig, ...globalConfig, ...envOverrides};
