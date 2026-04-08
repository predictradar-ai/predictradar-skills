export function shouldLogVerboseWatchRuntimeEvents(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COPYHUNTER_VERBOSE_WATCH_LOGS === '1';
}
