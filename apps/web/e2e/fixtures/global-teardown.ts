import { E2E_DOWN, E2E_STACK } from './env';

/** Keeps the stack running between runs (fast reruns), unless E2E_DOWN=1. */
export default async function globalTeardown(): Promise<void> {
  if (!E2E_DOWN) return;
  const { down } = await import('../harness/stack');
  await down(E2E_STACK, { log: (line) => console.log(`[pile ${E2E_STACK}] ${line}`) });
}
