/**
 * THE ONLY place where a shell is used by the runner.
 *
 * Project commands (« npm run dev », « npx playwright test devis », the install command) are the
 * project's own commands, typed or confirmed by the owner in the UI (or detected from the
 * lockfile for the install step). They need a shell (pipes, `&&`, npm `.cmd` shims on Windows), so
 * they run through the platform shell, inside the project's worktree, with a sanitised
 * environment. Nothing else in the runner ever builds a command line: git, tmux and the Claude
 * CLI are always started with an argument array.
 */

/** For child_process.spawn (pass `windowsVerbatimArguments: true` on Windows). */
export function platformShell(command: string): { file: string; args: string[]; verbatim: boolean } {
  if (process.platform === 'win32') {
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${command}"`], verbatim: true };
  }
  return { file: '/bin/sh', args: ['-c', command], verbatim: false };
}

/** For node-pty: on Windows the argument string is passed verbatim to CreateProcess. */
export function platformShellForPty(command: string): { file: string; args: string[] | string } {
  if (process.platform === 'win32') {
    return { file: process.env.ComSpec || 'cmd.exe', args: `/d /s /c "${command}"` };
  }
  return { file: '/bin/sh', args: ['-c', command] };
}
