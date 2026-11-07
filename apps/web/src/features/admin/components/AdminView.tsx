'use client';

import { useSearchParams } from 'next/navigation';
import { createContext, useCallback, useContext, useState, useTransition, type ReactNode } from 'react';
import { PageHeader } from '@/components/shell';
import { Button, IconButton, Tabs, TabsContent, TabsList, TabsTrigger, toast } from '@/components/ui';
import { tabHistoryMode } from '@/hooks/useMediaQuery';
import type { AdministrationData } from '@/server/admin';
import { reloadAdministrationAction } from '../actions';
import { AdminClaudeTab } from '@/features/claude-config/components/AdminClaudeTab';
import { ADMIN_TABS, parseAdminTab, type AdminTab } from '../lib/copy';
import { AccountsTab, InviteDialog } from './AccountsTab';
import { InstanceTab } from './InstanceTab';
import { JournalTab } from './JournalTab';
import { ServersTab } from './ServersTab';

interface AdminContextValue {
  data: AdministrationData;
  /** Re-reads every section from the server (after a mutation). */
  refresh: () => void;
  refreshing: boolean;
}

const AdminContext = createContext<AdminContextValue | null>(null);

export function useAdmin(): AdminContextValue {
  const value = useContext(AdminContext);
  if (!value) throw new Error('useAdmin() hors de <AdminView>.');
  return value;
}

function writeTab(tab: AdminTab): void {
  const url = new URL(window.location.href);
  if (tab === 'comptes') url.searchParams.delete('onglet');
  else url.searchParams.set('onglet', tab);
  if (tab !== 'claude') url.searchParams.delete('section');
  const next = `${url.pathname}${url.search}${url.hash}`;
  if (next === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
  // Phone: the tabs are one screen, the back arrow leaves the page (replace); desktop: one entry per tab.
  if (tabHistoryMode() === 'push') window.history.pushState(null, '', next);
  else window.history.replaceState(null, '', next);
}

/**
 * /administration (owner and administrators): tabs « Comptes · Serveurs · Instance · Journal »
 * (`?onglet=`), desktop and phone. Every mutation goes through a server action, then the whole page
 * data is read again (no optimistic state).
 */
export function AdminView({ initial }: { initial: AdministrationData }) {
  const [data, setData] = useState(initial);
  const [refreshing, startRefresh] = useTransition();
  const params = useSearchParams();
  const [tab, setTab] = useState<AdminTab>(() => parseAdminTab(params.get('onglet')));
  const [inviting, setInviting] = useState(() => params.get('inviter') === '1');

  const refresh = useCallback(() => {
    startRefresh(async () => {
      const result = await reloadAdministrationAction();
      if (result.ok) setData(result.data);
      else toast({ message: result.error.message, icon: 'alert' });
    });
  }, []);

  const select = (value: string) => {
    const next = parseAdminTab(value);
    setTab(next);
    writeTab(next);
  };

  return (
    <AdminContext.Provider value={{ data, refresh, refreshing }}>
      <div className="flex min-w-0 flex-col gap-3 nav:gap-5">
        <PageHeader
          title="Administration"
          subtitle="Comptes, serveurs, configuration Claude commune et journal de l'instance."
          actions={
            <Button variant="accent" onClick={() => setInviting(true)}>
              Inviter un compte
            </Button>
          }
          mobileAction={<IconButton icon="plus" label="Inviter un compte" onClick={() => setInviting(true)} />}
        />
        <Tabs value={tab} onValueChange={select} activationMode="manual" className="flex flex-col gap-5">
          <TabsList aria-label="Sections de l'administration">
            {ADMIN_TABS.map((item) => (
              <TabsTrigger key={item.value} value={item.value}>
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="comptes" tabIndex={-1}>
            <AccountsTab />
          </TabsContent>
          <TabsContent value="serveurs" tabIndex={-1}>
            <ServersTab openRegister={new URLSearchParams(params.toString()).get('ajout') === '1'} />
          </TabsContent>
          <TabsContent value="instance" tabIndex={-1}>
            <InstanceTab />
          </TabsContent>
          <TabsContent value="claude" tabIndex={-1}>
            <AdminClaudeTab initialSection={params.get('section')} />
          </TabsContent>
          <TabsContent value="journal" tabIndex={-1}>
            <JournalTab />
          </TabsContent>
        </Tabs>
        <InviteDialog open={inviting} onOpenChange={setInviting} />
      </div>
    </AdminContext.Provider>
  );
}

/** A section that could not be read: its own French message, the other tabs keep working. */
export function SectionError({ title, message, children }: { title: string; message: string; children?: ReactNode }) {
  const { refresh, refreshing } = useAdmin();
  return (
    <div className="flex flex-col gap-3">
      <p role="alert" className="m-0 font-sans text-app-14 font-semibold text-text">
        {title}
      </p>
      <p className="m-0 font-sans text-app-13 text-muted">{message}</p>
      {children}
      <Button variant="default" onClick={refresh} loading={refreshing} loadingLabel="Lecture…" className="self-start">
        Réessayer
      </Button>
    </div>
  );
}
