import { writeFile } from 'node:fs/promises';
import { collectHuaweiRules, parseUpdate } from './huawei-rules';

async function seed() {
  const [, , directory, output] = process.argv;
  if (!directory || !output) throw new Error('需要华为 log 文档目录和输出文件。');
  const result = await collectHuaweiRules(directory, undefined, 'CloudEngine S16700 V600R025C00');
  const seed = { schemaVersion: 1, rules: result.rules };
  if (!seed.rules.length || parseUpdate(seed).issues.length) throw new Error('没有可用的内置华为规则。');
  await writeFile(output, JSON.stringify(seed), 'utf8');
  console.log(JSON.stringify({ extracted: seed.rules.length, invalid: result.issues.length, skipped: result.skipped }));
}

seed().catch(error => { console.error(error.message); process.exitCode = 1; });
