import { GracefulCluster } from 'graceful-cluster';
import * as sysUtils from './utils.js';

process.title = 'iframely-cluster';

GracefulCluster.start({
    log: sysUtils.log,
    // When undefined, graceful-cluster falls back to os.cpus().length, which is
    // the HOST node's vCPU count and ignores the container's CPU limit — forking
    // far too many workers on large nodes (each loads ~1886 domains + Redis +
    // Secrets Manager). Cap it via IFRAMELY_WORKERS_COUNT (see config.loader.js).
    workersCount: CONFIG.CLUSTER_WORKERS_COUNT,
    shutdownTimeout: CONFIG.SHUTDOWN_TIMEOUT,
    disableGraceful: CONFIG.DEBUG,
    restartOnTimeout: CONFIG.CLUSTER_WORKER_RESTART_ON_PERIOD,
    restartOnMemory: CONFIG.CLUSTER_WORKER_RESTART_ON_MEMORY_USED,
    serverFunction: function() {
        import('./server.js');
    }
});
