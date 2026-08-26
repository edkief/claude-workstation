#!/usr/bin/env node
'use strict';

/**
 * Prune workspace PVCs that have not been used for N days.
 *
 * Successor to the old api/cleanup.js cron, which deleted directories on a
 * shared volume. Storage is now per-repo PVCs that deliberately outlive
 * sessions, so the default window is much longer -- a PVC holds a warm checkout
 * and node_modules that are expensive to rebuild.
 *
 * Run by k8s/cleanup-cronjob.yaml.
 */

const k8s = require('./lib/k8s');
const pvcs = require('./lib/pvcs');

function parseArgs(argv) {
    const args = { days: 30, dryRun: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--days') args.days = parseInt(argv[++i], 10);
        else if (argv[i] === '--dry-run') args.dryRun = true;
    }
    if (!Number.isInteger(args.days) || args.days < 0) {
        console.error('--days must be an integer >= 0');
        process.exit(2);
    }
    return args;
}

async function main() {
    const { days, dryRun } = parseArgs(process.argv.slice(2));

    const [claims, pods] = await Promise.all([
        pvcs.listWorkspacePvcs({ skipCache: true }),
        k8s.listWorkspacePods(),
    ]);

    const inUse = new Set();
    for (const pod of pods) {
        const claim = pod.spec?.volumes?.find((v) => v.persistentVolumeClaim)
            ?.persistentVolumeClaim?.claimName;
        if (claim) inUse.add(claim);
    }

    const deleted = [];
    let freedGi = 0;

    for (const pvc of claims) {
        const w = pvcs.describePvc(pvc, { inUse: inUse.has(pvc.metadata.name) });
        // Never touch a volume a live pod has mounted, whatever its age.
        if (w.inUse) {
            console.log(`skip  ${w.name} (in use)`);
            continue;
        }
        if (w.ageDays === null || w.ageDays < days) {
            console.log(`keep  ${w.name} (${w.ageDays ?? '?'}d < ${days}d)`);
            continue;
        }
        if (dryRun) {
            console.log(`DRY   ${w.name} (${w.ageDays}d, ${w.usedGi ?? '?'}Gi)`);
        } else {
            await pvcs.deletePvc(w.name);
            console.log(`prune ${w.name} (${w.ageDays}d, ${w.usedGi ?? '?'}Gi)`);
        }
        deleted.push(w);
        freedGi += w.usedGi || 0;
    }

    console.log(`\n${dryRun ? 'would free' : 'freed'} ~${freedGi.toFixed(2)}Gi ` +
        `across ${deleted.length} workspace(s)`);
}

main().catch((err) => {
    console.error('prune failed:', k8s.apiMessage(err));
    process.exit(1);
});
