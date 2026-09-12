import { promises as fs } from 'node:fs';
import { join } from 'node:path';

const workflowsDirectory = join(process.cwd(), '.github', 'workflows');
const workflowNames = (await fs.readdir(workflowsDirectory)).filter((name) =>
  name.endsWith('.yml'),
);
const findings = [];

for (const name of workflowNames) {
  const source = await fs.readFile(join(workflowsDirectory, name), 'utf8');
  const lines = source.split('\n');

  if (!/^permissions:/m.test(source)) findings.push(`${name}: missing top-level permissions`);

  for (const [index, line] of lines.entries()) {
    const action = line.match(/^\s*uses:\s*([^#\s]+)(?:\s*#.*)?$/)?.[1];
    if (action && !action.startsWith('./')) {
      const reference = action.slice(action.lastIndexOf('@') + 1);
      if (!/^[0-9a-f]{40}$/.test(reference)) {
        findings.push(`${name}:${index + 1}: action is not pinned to a full commit SHA`);
      }
    }

    if (/uses:\s*actions\/checkout@/.test(line)) {
      const followingStep = lines.slice(index + 1, index + 8).join('\n');
      if (!/persist-credentials:\s*false/.test(followingStep)) {
        findings.push(`${name}:${index + 1}: checkout persists credentials`);
      }
    }
  }
}

if (findings.length > 0) {
  console.error(findings.join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    `Checked ${workflowNames.length} workflows: pinned actions and checkout credentials OK`,
  );
}
