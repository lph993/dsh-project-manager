import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
const pattern = process.argv[3] ?? 'register({';
const context = Number(process.argv[4] ?? 700);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (full.endsWith('client.js')) out.push(full);
  }
  return out;
}

for (const file of walk(root)) {
  const text = readFileSync(file, 'utf8');
  let index = text.indexOf(pattern);
  while (index !== -1) {
    const slice = text.slice(Math.max(0, index - 200), index + context);
    if (/main|panellist/.test(slice)) {
      console.log(`===== ${file} @${index} =====`);
      console.log(slice);
    }
    index = text.indexOf(pattern, index + 1);
  }
}
