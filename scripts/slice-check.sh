#!/usr/bin/env bash
# Slices the projects of scripts/slice-check.ts with the Bambu Studio in the running container and
# reports, per case, the return code and whether the G-code differs from its base.
#   scripts/slice-check.sh <work-dir>      (a host folder for the temporary files)
# The slicer is not deterministic (it reorders a few moves between runs), so every project is sliced
# ROUNDS times and a case "differs" only when none of its G-codes (comments dropped, lines sorted)
# equals any of its base's. Only /tmp/slice-check inside the container is touched; it is removed at the end.
set -euo pipefail
work=${1:?usage: slice-check.sh <work-dir>}
rounds=${ROUNDS:-4}
c=prompt-to-part-app-1
root=$(cd "$(dirname "$0")/.." && pwd)
rm -rf "$work"; mkdir -p "$work/in" "$work/out"
docker exec $c cat /data/bambu/templates/bambu-lab-a1-0-4-nozzle.json > "$work/template.json"
(cd "$root" && node --import tsx scripts/slice-check.ts "$work/in" "$work/template.json")
cleanup() { docker exec $c rm -rf /tmp/slice-check; }
trap cleanup EXIT
docker exec $c rm -rf /tmp/slice-check
(cd "$work/in" && tar -cf - .) | docker exec -i $c sh -c 'mkdir -p /tmp/slice-check && tar -C /tmp/slice-check -xf -'
names=$(cut -d' ' -f1 "$work/in/cases.txt" | tr '\n' ' ')
docker exec $c sh -c "cd /tmp/slice-check && for r in \$(seq $rounds); do for n in $names; do bambustudio --datadir /tmp/slice-check/dd --slice 0 --export-3mf sliced.3mf --outputdir /tmp/slice-check/out-\$n-\$r \$n.3mf >/dev/null 2>&1 || true; done; done"
docker exec $c sh -c 'cd /tmp/slice-check && tar -cf - out-*' | tar -C "$work/out" -xf -
cd "$root" && node - "$work" "$rounds" <<'JS'
const { unzipSync } = require('fflate'), fs = require('fs'), crypto = require('crypto');
const [work, rounds] = [process.argv[2], +process.argv[3]];
const cases = fs.readFileSync(`${work}/in/cases.txt`, 'utf8').trim().split('\n').map((l) => l.split(' '));
const run = (n, r) => {
  const dir = `${work}/out/out-${n}-${r}`;
  let rc = '?'; try { rc = String(JSON.parse(fs.readFileSync(`${dir}/result.json`, 'utf8')).return_code); } catch {}
  let g = ''; try { g = Buffer.from(unzipSync(new Uint8Array(fs.readFileSync(`${dir}/sliced.3mf`)))['Metadata/plate_1.gcode']).toString(); } catch {}
  const sum = g ? crypto.createHash('md5').update(g.split('\n').filter((x) => !x.startsWith(';')).sort().join('\n')).digest('hex') : 'none';
  return { rc, sum, infill: g.includes('; FEATURE: Sparse infill'), support: g.includes('; FEATURE: Support') };
};
const all = Object.fromEntries(cases.map(([n]) => [n, Array.from({ length: rounds }, (_, i) => run(n, i + 1))]));
console.log('case'.padEnd(30), 'rc'.padEnd(4), 'vs base'.padEnd(10), 'variants', 'features');
for (const [n, b] of cases) {
  const runs = all[n], mine = new Set(runs.map((r) => r.sum)), theirs = new Set(all[b].map((r) => r.sum));
  const rc = [...new Set(runs.map((r) => r.rc))].join('/');
  const vs = n === b ? '(base)' : [...mine].some((s) => theirs.has(s)) ? 'same' : 'differs';
  const f = (runs.some((r) => r.infill) ? 'infill' : '-') + (runs.some((r) => r.support) ? ',support' : '');
  console.log(n.padEnd(30), rc.padEnd(4), vs.padEnd(10), String(mine.size).padEnd(8), f);
}
JS
