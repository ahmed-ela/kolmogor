import { useLayoutEffect, useMemo, useRef, useState } from 'octane';
import { Button } from '@octanejs/shadcn/Button';
import { Icon } from './Icon';
import { AgentStatusIcon } from './AgentStatusIcon';
import { sidebarRowHeight, useSidebarWindow } from './sidebarWindow';
import type { AppSnapshot, DesktopSection, NativeAction } from './types';

type Action = (action: NativeAction) => void;
type Row = { heading: string; label: string; expanded: boolean } | DesktopSection['chats'][number];

export function desktopRows(sections: DesktopSection[], search: string): Row[] {
  const term = search.trim().toLocaleLowerCase();
  return sections.flatMap(section => {
    const chats = section.chats.filter(chat => chat.title.toLocaleLowerCase().includes(term));
    if (term && !chats.length) return [];
    const expanded = Boolean(term) || !section.isCollapsed;
    return [{ heading: section.id, label: section.name, expanded }, ...(expanded ? chats : [])];
  });
}

type ListProps = { collapsed: boolean; search: string; post: Action };

function ChatRows({sections, collapsed, search, post, select, selectedID, busyID, source = false, status}: ListProps & {
  sections: DesktopSection[]; select: (id: string) => void; selectedID?: string;
  busyID?: string | null; source?: boolean; status?: string;
}) {
  const list = useRef<HTMLElement | null>(null);
  const rows = useMemo(() => desktopRows(sections, search), [sections, search]);
  const searching = Boolean(search.trim());
  const { start, end } = useSidebarWindow(list, rows.length);
  useLayoutEffect(() => { if (list.current) list.current.scrollTop = 0; }, [search]);
  return <nav ref={list} className={'task-list' + (collapsed ? ' agent-rail' : '')} aria-label={source ? 'Available Codex chats' : 'Saved imported chats'}
    style={{ '--sidebar-row-height': sidebarRowHeight + 'px' }}>
    {status && <p className="sidebar-empty" role="status">{status}</p>}
    {!status && !sections.some(section => section.chats.length) ? <p className="sidebar-empty">{source ? 'No Codex chats available' : 'No imported chats yet'}</p>
      : !status && !rows.length && <p className="sidebar-empty">No matching chats</p>}
    {start > 0 && <div aria-hidden="true" style={{height: start * sidebarRowHeight + 'px'}} />}
    {rows.slice(start, end).map(row => 'heading' in row
      ? <h2 key={'section:' + row.heading} className="sidebar-section-heading" data-desktop-section={row.heading} title={row.label}>
          {searching ? <span className={collapsed ? 'sr-only' : undefined}>{row.label}</span> : (
            <button type="button" className="desktop-section-toggle" aria-expanded={row.expanded}
              onClick={() => post({ action: 'setDesktopSectionCollapsed', id: row.heading, collapsed: row.expanded })}
              onKeyDown={event => {
                if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                const collapse = event.key === 'ArrowLeft';
                if (collapse === row.expanded) post({ action: 'setDesktopSectionCollapsed', id: row.heading, collapsed: collapse });
              }}>
              <Icon name="chevron" size={13} />
              <span className={collapsed ? 'sr-only' : undefined}>{row.label}</span>
            </button>
          )}
        </h2>
      : <div key={row.id} className="workspace-tab-row" data-desktop-chat={row.id}>
          <Button variant="ghost" className={'task-row' + (collapsed ? ' agent-rail-button' : '') + (selectedID === row.id ? ' selected' : '')}
            aria-label={source ? 'Import ' + row.title : row.title} title={row.title} disabled={!!busyID} aria-current={selectedID === row.id ? 'page' : undefined}
            onClick={() => select(row.id)}>
            <AgentStatusIcon taskID={row.id} working={false} />
            {!collapsed && <span className="task-row-title">{busyID === row.id ? 'Importing…' : row.title}</span>}
          </Button></div>)}
    {end < rows.length && <div aria-hidden="true" style={{height:(rows.length-end)*sidebarRowHeight+'px'}} />}
  </nav>;
}

function ImportSources({snapshot, request, collapsed, post}: {
  snapshot: AppSnapshot; request: string; collapsed: boolean; post: Action;
}) {
  const [search, setSearch] = useState('');
  const [failure, setFailure] = useState('');
  const [copying, setCopying] = useState<string | null>(null);
  async function select(id: string) {
    if (copying) return;
    setCopying(id); setFailure('');
    try {
      const bridge = window.webkit?.messageHandlers?.codexConversation;
      if (!bridge) throw new Error('The import service is unavailable.');
      await bridge.postMessage({action:'import', thread:id, selection:request});
    } catch (e) { setFailure(e instanceof Error ? e.message : String(e)); }
    finally { setCopying(null); }
  }
  return <>
    {!collapsed && <div className="sidebar-search-row"><div className="task-search">
      <Icon name="search" size={15} />
      <input type="search" aria-label="Search Codex chats" placeholder="Search Codex chats" value={search}
        onInput={event => setSearch((event.currentTarget as HTMLInputElement).value)} />
    </div></div>}
    {failure && <p className="sidebar-empty" role="alert">{failure}</p>}
    <ChatRows sections={snapshot.codexImportSections ?? []} status={snapshot.codexImportError ?? (snapshot.codexImportSections ? undefined : 'Looking for Codex chats…')}
      search={search} collapsed={collapsed} post={post} source busyID={copying} select={select} />
  </>;
}

export function DesktopChatList({snapshot, collapsed, search, post}: ListProps & { snapshot: AppSnapshot }) {
  const request = snapshot.codexImportRequest;
  const toggleLabel = request ? 'Close Codex picker' : 'Import from Codex';
  return <>
    <Button className="codex-import-toggle" variant="ghost" title={toggleLabel} aria-label={toggleLabel} aria-expanded={!!request}
      onClick={() => post({action: request ? 'closeCodexImports' : 'browseCodexImports'})}>
      {collapsed ? <Icon name="terminal" size={15} /> : request ? toggleLabel : 'Import from Codex…'}
    </Button>
    <ChatRows sections={snapshot.desktopSections ?? []} selectedID={snapshot.desktopReader?.id} status={snapshot.desktopSidebarError}
      search={search} collapsed={collapsed} post={post} select={id => post({action:'openDesktopChat', id})} />
    {request && <ImportSources key={request} snapshot={snapshot} request={request} collapsed={collapsed} post={post} />}
  </>;
}

export function DesktopChatScope({selected, collapsed, choose}: {selected: boolean; collapsed: boolean; choose: (enabled:boolean)=>void}) {
  return <div className={'desktop-chat-scope' + (collapsed ? ' compact' : '')} role="group" aria-label="Chat source">
    {[false, true].map(desktop => <Button key={String(desktop)} variant="ghost" aria-pressed={selected === desktop}
      aria-label={desktop ? 'Imported chats' : 'Kolmogor agents'} title={desktop ? 'Imported chats' : 'Kolmogor agents'}
      onClick={() => choose(desktop)}>{collapsed ? <Icon name={desktop ? 'terminal' : 'computer'} size={15} /> : desktop ? 'Imports' : 'Agents'}</Button>)}
  </div>;
}
