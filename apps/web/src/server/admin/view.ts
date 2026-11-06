import 'server-only';
import { toAppError } from '@/server/errors';
import { listAccounts, type AdminAccountView } from './accounts';
import type { AdminActor } from './common';
import { getInstanceJournal, getInstanceView, type InstanceJournalEntry, type InstanceView } from './instance';
import { listInvitations, type AdminInvitationView } from './invitations';
import { listServers, type AdminServerView } from './servers';

/**
 * Everything /administration shows, each section loaded on its own (a failure stays in its tab, with
 * its French message — never a fake state).
 */

export type Section<T> = { ok: true; data: T } | { ok: false; error: { message: string } };

export interface AdministrationData {
  accounts: Section<AdminAccountView[]>;
  invitations: Section<AdminInvitationView[]>;
  servers: Section<AdminServerView[]>;
  instance: Section<InstanceView>;
  journal: Section<{ items: InstanceJournalEntry[]; nextCursor: number | null }>;
  /** The administrator looking at the console. */
  self: { id: string; role: AdminActor['role'] };
  /** Server time of the render (relative dates computed the same way on both sides). */
  now: string;
}

async function section<T>(load: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, data: await load() };
  } catch (error) {
    const appError = toAppError(error);
    if (appError.code === 'INTERNAL') console.error('[administration] lecture impossible', error);
    return { ok: false, error: { message: appError.message } };
  }
}

export async function loadAdministration(actor: AdminActor): Promise<AdministrationData> {
  const [accounts, invitations, servers, instance, journal] = await Promise.all([
    section(() => listAccounts(actor)),
    section(() => listInvitations(actor)),
    section(() => listServers(actor)),
    section(() => getInstanceView(actor)),
    section(() => getInstanceJournal(actor, { limit: 50 })),
  ]);
  return { accounts, invitations, servers, instance, journal, self: { id: actor.id, role: actor.role }, now: new Date().toISOString() };
}
