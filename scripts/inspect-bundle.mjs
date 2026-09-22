import { readFileSync } from 'node:fs';

const file = process.argv[2];
const text = readFileSync(file, 'utf8');
const needles = ['"main"', 'main:', 'keyed', 'activePanelId', 'selectPanel', 'children:'];
for (const needle of needles) {
  console.log(`${needle} -> ${text.indexOf(needle)}`);
}
const i = text.indexOf('selectPanel');
console.log('--- around selectPanel ---');
console.log(text.slice(Math.max(0, i - 1200), i + 1600));
