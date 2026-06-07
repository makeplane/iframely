    import log from '../logging.js';

    // ---------------------------------------------------------------------------
    // AWS Secrets Manager helper (Plane fork extension).
    //
    // Port of plane-ee/apps/silo/src/lib/aws-secrets.ts to plain ESM. Fetches a
    // secret by ARN and TTL-caches the parsed JSON so repeated lookups (e.g. the
    // periodic credential refresh in the redis cache engine) don't hammer the API.
    //
    // The AWS SDK is lazy-imported so deployments that never set a *_SECRET_ARN
    // do not need `@aws-sdk/client-secrets-manager` installed/loaded.
    // ---------------------------------------------------------------------------

    const secretCache = new Map(); // key: `${arn}:${region}` -> { value, fetchedAt }

    export async function getSecret(secretArn, region, forceRefresh = false) {

        const cacheTtl = parseInt(process.env.AWS_SECRET_CACHE_TTL || '300', 10) * 1000;
        const key = secretArn + ':' + region;
        const now = Date.now();

        if (!forceRefresh && secretCache.has(key)) {
            const entry = secretCache.get(key);
            if (now - entry.fetchedAt < cacheTtl) {
                return { ...entry.value };
            }
        }

        const { SecretsManagerClient, GetSecretValueCommand } =
            await import('@aws-sdk/client-secrets-manager');

        const client = new SecretsManagerClient({ region });
        const response = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
        const value = JSON.parse(response.SecretString || '{}');

        secretCache.set(key, { value, fetchedAt: now });
        log('   -- Secrets Manager: refreshed secret ' + secretArn);

        return { ...value };
    };
