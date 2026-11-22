import { spawnSync } from 'node:child_process';

// Pass the URL over stdin so it stays out of the process arguments and terminal output.
export function copyLocalSessionUrl(url) {
  const copied = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Set-Clipboard -Value ([Console]::In.ReadToEnd()) -ErrorAction Stop'],
    { input: url, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  if (copied.status !== 0) throw Error('Could not prepare the local Chrome clipboard.');
}
