#!/usr/bin/env bash
# Slices the projects of scripts/slice-check.ts with the Bambu Studio in the running container and
# reports, per case, the return code (and the slicer's error, if any) and whether the G-code differs from its base.
#   scripts/slice-check.sh <parent-dir>    (a host folder; the files go in a new folder made inside it, which is
#                                           kept so the G-code can be read: out/out-<case>-<round>/sliced.3mf)
# The slicer is not deterministic (it reorders a few moves between runs), so every project is sliced
# ROUNDS times and a case "differs" only when none of its G-codes (comments dropped, lines sorted)
# equals any of its base's. Only /tmp/slice-check inside the container is touched; it is removed at the end.
set -euo pipefail
parent=${1:?usage: slice-check.sh <parent-dir>}
rounds=${ROUNDS:-4}
c=prompt-to-part-app-1
root=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$parent"
work=$(mktemp -d "$parent/slice-check.XXXXXX")
mkdir "$work/in" "$work/out"
echo "work folder: $work"
docker exec $c cat /data/bambu/templates/bambu-lab-a1-0-4-nozzle.json > "$work/template.json"
(cd "$root" && node --import tsx scripts/slice-check.ts "$work/in" "$work/template.json")
cleanup() { docker exec $c rm -rf /tmp/slice-check; }
trap cleanup EXIT
docker exec $c rm -rf /tmp/slice-check
(cd "$work/in" && tar -cf - .) | docker exec -i $c sh -c 'mkdir -p /tmp/slice-check && tar -C /tmp/slice-check -xf -'
names=$(cut -d' ' -f1 "$work/in/cases.txt" | tr '\n' ' ')
docker exec $c sh -c "cd /tmp/slice-check && for r in \$(seq $rounds); do for n in $names; do o=out-\$n-\$r; mkdir -p \$o; bambustudio --datadir /tmp/slice-check/dd --slice 0 --export-3mf sliced.3mf --outputdir /tmp/slice-check/\$o \$n.3mf >\$o/log.txt 2>&1; echo \$? >\$o/exit; done; done"
docker exec $c sh -c 'cd /tmp/slice-check && tar -cf - out-*' | tar -C "$work/out" -xf -
cd "$root" && node - "$work" "$rounds" <<'JS'
const { unzipSync } = require('fflate'), fs = require('fs'), crypto = require('crypto');
const [work, rounds] = [process.argv[2], +process.argv[3]];
const cases = fs.readFileSync(`${work}/in/cases.txt`, 'utf8').trim().split('\n').map((l) => l.split(' '));
const run = (n, r) => {
  const dir = `${work}/out/out-${n}-${r}`;
  // The return code from result.json (else the exit code); on a failure the slicer's own reason from its log
  // ("got error when validate: ..."), else result.json's general error_string.
  let rc = '?', err = '';
  try { const j = JSON.parse(fs.readFileSync(`${dir}/result.json`, 'utf8')); rc = String(j.return_code); err = j.error_string ?? ''; } catch {
    try { rc = fs.readFileSync(`${dir}/exit`, 'utf8').trim(); } catch {}
  }
  try { const m = /got error when validate: (.*)/.exec(fs.readFileSync(`${dir}/log.txt`, 'utf8')); if (m) err = m[1].trim(); } catch {}
  if (rc === '0') err = '';
  let g = ''; try { g = Buffer.from(unzipSync(new Uint8Array(fs.readFileSync(`${dir}/sliced.3mf`)))['Metadata/plate_1.gcode']).toString(); } catch {}
  const sum = g ? crypto.createHash('md5').update(g.split('\n').filter((x) => !x.startsWith(';')).sort().join('\n')).digest('hex') : 'none';
  return { rc, err, sum, infill: g.includes('; FEATURE: Sparse infill'), support: g.includes('; FEATURE: Support') };
};
const all = Object.fromEntries(cases.map(([n]) => [n, Array.from({ length: rounds }, (_, i) => run(n, i + 1))]));
console.log('case'.padEnd(30), 'rc'.padEnd(4), 'vs base'.padEnd(10), 'variants', 'features');
for (const [n, b] of cases) {
  const runs = all[n], mine = new Set(runs.map((r) => r.sum)), theirs = new Set(all[b].map((r) => r.sum));
  const rc = [...new Set(runs.map((r) => r.rc))].join('/');
  const vs = n === b ? '(base)' : [...mine].some((s) => theirs.has(s)) ? 'same' : 'differs';
  const f = (runs.some((r) => r.infill) ? 'infill' : '-') + (runs.some((r) => r.support) ? ',support' : '');
  const err = [...new Set(runs.map((r) => r.err).filter(Boolean))].join(' / ');
  console.log(n.padEnd(30), rc.padEnd(4), vs.padEnd(10), String(mine.size).padEnd(8), f, err ? `error: ${err}` : '');
}
JS
