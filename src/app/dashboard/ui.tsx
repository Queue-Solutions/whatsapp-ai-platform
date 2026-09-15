'use client';
import Image from 'next/image';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { KnowledgeEditor, type Membership } from '@/modules/admin/knowledge-editor';
import { branchFields, emptyBranch, type Branch, type Faq } from '@/modules/knowledge/questionnaire';
import './dashboard.css';
import { Inbox } from './inbox-ui';
import { AttentionLink } from './inbox-attention';

type Config = { url: string; key: string } | null;
export function Dashboard({ config, view='knowledge' }: { config: Config; view?:'knowledge'|'inbox' }) {
  const db = useMemo(() => config ? createClient(config.url, config.key) : null, [config]);
  const [userId, setUserId] = useState<string | null>(null);
  const [checking, setChecking] = useState(!!db);
  useEffect(() => {
    if (!db) return;
    let active = true;
    void db.auth.getSession().then(({ data }) => { if (active) { setUserId(data.session?.user.id ?? null); setChecking(false); } }).catch(() => { if (active) setChecking(false); });
    const { data } = db.auth.onAuthStateChange((_event, session) => { setUserId(session?.user.id ?? null); setChecking(false); });
    return () => { active = false; data.subscription.unsubscribe(); };
  }, [db]);
  return <div className="dashboard">
    <aside className="sidebar"><a className="brand" href="/dashboard" aria-label="Queue Solutions home"><span className="brand-mark"><Image src="/queue-solutions-logo.png" alt="" width={80} height={80} priority /></span><span className="brand-name">queue<span className="brand-small">SOLUTIONS</span></span></a>
      <div className="workspace-label">YOUR WORKSPACE</div><a href="/dashboard" className={view==='knowledge'?'nav-active':'nav-link'}><span aria-hidden="true">▤</span> Business knowledge</a><a href="/dashboard/inbox" className={view==='inbox'?'nav-active':'nav-link'}><span aria-hidden="true">☷</span> Inbox {userId && db && <AttentionLink key={userId} db={db} compact />}</a>
      <div className="sidebar-bottom"><span className="status-dot" /> Your business, in your words.<p>Give your assistant the answers your customers need.</p></div>
    </aside>
    <div className="dashboard-main"><header className="topbar"><span>Workspace <span className="slash">/</span> {view==='inbox'?'Inbox':'Business knowledge'}</span>{userId && db ? <AttentionLink key={userId} db={db} /> : <span className="workspace-badge">Queue Solutions</span>}</header>
      {checking ? <main className="content"><p role="status">Checking your session…</p></main> : userId && db ? view==='inbox'?<Inbox key={userId} db={db}/>:<Editor key={userId} db={db} /> : <Login db={db} />}
      <footer className="site-footer"><a href="https://queuesolutions.org" target="_blank" rel="noopener noreferrer"><span className="footer-mark"><Image src="/queue-solutions-logo.png" alt="" width={32} height={32} /></span><span>Made by <strong>Queue Solutions</strong></span></a></footer>
    </div>
  </div>;
}
function Login({ db }: { db: SupabaseClient | null }) {
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function signIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!db) return;
    const form = new FormData(event.currentTarget); setBusy(true); setError('');
    try {
      const { error } = await db.auth.signInWithPassword({ email: String(form.get('email')).trim(), password: String(form.get('password')) });
      if (error) setError('Could not sign in. Check your email and password and try again.');
    } catch { setError('Could not connect. Please try again.'); } finally { setBusy(false); }
  }
  return <main className="login-wrap"><div className="eyebrow">BUSINESS KNOWLEDGE</div><h1>A helpful answer<br />starts with you.</h1><p className="intro">Add your locations, opening hours and frequently asked questions. Keep every answer accurate and up to date.</p>
    <form className="login-card" onSubmit={signIn}><h2>Sign in to your workspace</h2><p>Use the account provided by your administrator.</p>
      <label>Email address<input name="email" type="email" autoComplete="username" required disabled={!db || busy} /></label>
      <label>Password<input name="password" type="password" autoComplete="current-password" required disabled={!db || busy} /></label>
      {!db && <p className="notice">Dashboard access is being prepared. Your administrator needs to finish the sign-in setup.</p>}
      {error && <p className="error" role="alert">{error}</p>}<button className="primary" disabled={!db || busy}>{busy ? 'Signing in…' : 'Sign in →'}</button>
    </form></main>;
}
export function Editor({ db }: { db: SupabaseClient }) {
  const editor = useMemo(() => new KnowledgeEditor(db), [db]);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [tenant, setTenant] = useState(''); const [locale, setLocale] = useState('en');
  const [faqs, setFaqs] = useState<Faq[]>([]); const [branches, setBranches] = useState<Branch[]>([]);
  const [tab, setTab] = useState<'branches' | 'faqs'>('branches');
  const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [feedbackId, setFeedbackId] = useState('');
  const [busy, setBusy] = useState(''); const [deleting, setDeleting] = useState(false); const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [reload, setReload] = useState(0); const scope = useRef(0);
  const canEdit = ['owner','admin'].includes(memberships.find(m => m.tenant_id === tenant)?.role ?? '');
  useEffect(() => {
    let active = true;
    void editor.memberships().then(rows => { if (active) { setMemberships(rows); setTenant(rows[0]?.tenant_id ?? ''); if (!rows.length) setLoading(false); } }).catch(() => { if (active) { setError('Could not load your business access. Please sign out and try again.'); setLoading(false); } });
    return () => { active = false; };
  }, [editor]);
  useEffect(() => {
    if (!tenant) return;
    const generation = ++scope.current; let active = true;
    void editor.load(tenant, locale).then(data => {
      if (!active || generation !== scope.current) return;
      setFaqs(data.faqs); setBranches(data.branches.length ? data.branches : [newBranch()]); setLoading(false);
    }).catch(e => { if (active && generation === scope.current) { setError(e.message); setLoading(false); } });
    return () => { active = false; };
  }, [editor, tenant, locale, reload]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirty.size) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const resetView = () => { setFeedbackId(''); setLoading(true); setError(''); setNotice(''); setFaqs([]); setBranches([]); setDirty(new Set()); };
  const discard = () => !dirty.size || window.confirm('You have unsaved changes. Leave without saving them?');
  function mark(id: string) { setDirty(s => new Set(s).add(id)); if (feedbackId === id) { setError(''); setNotice(''); } }
  async function save(kind: 'faq' | 'branch', id: string) {
    if (!canEdit || busy) return; setFeedbackId(id); setBusy(id); setError(''); setNotice('');
    const generation = scope.current;
    try {
      if (kind === 'faq') { const result = await editor.saveFaq(tenant, locale, faqs.find(f => f.id === id)!, true); if (scope.current === generation) setFaqs(all => all.map(f => f.id === id ? result : f)); }
      else { const result = await editor.saveBranch(tenant, locale, branches.find(b => b.id === id)!, true); if (scope.current === generation) setBranches(all => all.map(b => b.id === id ? result : b)); }
      if (scope.current === generation) { setDirty(s => { const next = new Set(s); next.delete(id); return next; }); setNotice('Saved. This entry is now available to your assistant.'); }
    } catch (e) { if (scope.current === generation) setError(e instanceof Error ? e.message : 'Could not save. Please try again.'); }
    finally { setBusy(''); }
  }
  async function remove(kind: 'faq' | 'branch', id: string) {
    if (!canEdit || busy || !window.confirm(`Delete this ${kind === 'faq' ? 'question' : 'branch'}? It will no longer be available to your assistant.`)) return;
    setFeedbackId(id); setBusy(id); setDeleting(true); setError(''); setNotice('');
    const generation = scope.current;
    try {
      if (kind === 'faq') await editor.deleteFaq(tenant, locale, id);
      else if (branches.find(b => b.id === id)?.updated_at) await editor.deleteBranch(tenant, locale, id);
      if (scope.current === generation) {
        if (kind === 'faq') setFaqs(all => all.filter(f => f.id !== id));
        else setBranches(all => all.filter(b => b.id !== id));
        setDirty(s => { const next = new Set(s); next.delete(id); return next; });
        setFeedbackId(''); setNotice(kind === 'faq' ? 'Question deleted.' : 'Branch deleted.');
      }
    } catch (e) { if (scope.current === generation) setError(e instanceof Error ? e.message : 'Could not delete. Please try again.'); }
    finally { setBusy(''); setDeleting(false); }
  }
  const approved = [...faqs, ...branches].filter(x => x.is_published).length;
  return <main className="content"><div className="page-title"><div><div className="eyebrow">TEACH YOUR ASSISTANT</div><h1>Business knowledge</h1><p className="intro">You know your business. Give your assistant the details.</p></div><div className="account-actions"><button className="text-button" disabled={!!busy} onClick={() => setPasswordOpen(v => !v)}>Password</button><button className="text-button" disabled={!!busy} onClick={async () => { if (discard()) { await db.auth.signOut({ scope: 'local' }); } }}>Sign out</button></div></div>{passwordOpen && <PasswordForm db={db} onDone={() => setPasswordOpen(false)} />}
    <div className="toolbar"><label>Business<select value={tenant} disabled={!!busy || loading} onChange={e => { if (discard()) { resetView(); setTenant(e.target.value); } }}>{memberships.map(m => <option key={m.tenant_id} value={m.tenant_id}>{m.name}</option>)}</select></label>
      <label>Answer language<select value={locale} disabled={!!busy || loading} onChange={e => { if (discard()) { resetView(); setLocale(e.target.value); } }}><option value="en">English</option><option value="ar">Arabic / العربية</option></select></label><span className="draft-count">{approved} approved entries{dirty.size ? ` · ${dirty.size} unsaved` : ''}</span></div>
    <div className="guidance"><span className="guidance-icon" aria-hidden="true">i</span><div><strong>Start with what you know.</strong><p>Answers are blank for you to complete. Save an entry when it is ready for your assistant to share with customers. Complete the required details before saving. Delete entries you no longer need.</p></div></div>
    <div className="tabs" role="tablist" aria-label="Knowledge sections"><button role="tab" aria-selected={tab === 'branches'} onClick={() => { setTab('branches'); if (feedbackId) { setError(''); setNotice(''); } }}>Branches & hours <span>{branches.length}</span></button><button role="tab" aria-selected={tab === 'faqs'} onClick={() => { setTab('faqs'); if (feedbackId) { setError(''); setNotice(''); } }}>Frequently asked questions <span>{faqs.length}</span></button></div>
    <div aria-live="polite">{notice && !feedbackId && <p className="success">{notice}</p>}</div>{error && !feedbackId && <div className="error" role="alert">{error} <button className="text-button" disabled={!!busy} onClick={() => { if (discard()) { resetView(); setReload(n => n + 1); } }}>Reload</button></div>}
    {loading ? <p role="status">Loading your knowledge…</p> : !memberships.length ? <div className="empty-state"><h2>Your account needs business access</h2><p>Ask your administrator to assign you to a business. Signing in alone does not grant access.</p></div> : <>
      {!canEdit && <p className="notice">You have read-only access. An owner or admin can save changes.</p>}
      <div className="section-heading"><div><h2>{tab === 'branches' ? 'Make every location easy to find.' : 'Answer once. Help every customer.'}</h2><p>{tab === 'branches' ? 'Add one entry for each branch, including its own hours and Google Maps link.' : 'We have prepared the questions. Fill in the answers in your own words.'}</p></div>
        <button className="secondary" disabled={!canEdit || !!busy || (!!error && !feedbackId)} onClick={() => { if (tab === 'branches') { const row = newBranch(); setBranches(all => [...all, row]); mark(row.id); } else { const row = { id: crypto.randomUUID(), question: '', answer: '', is_published: false }; setFaqs(all => [...all, row]); mark(row.id); } }}>{tab === 'branches' ? '+ Add branch' : '+ Add question'}</button></div>
      <div className="entry-list">{tab === 'branches' ? branches.map((branch, i) => <article className="entry-card" key={branch.id}><div className="card-heading"><div className="card-number">{String(i + 1).padStart(2,'0')}</div><div><h3>{branch.value.name || `Branch ${i + 1}`}</h3><p>Location & opening hours</p></div><Badge published={branch.is_published} dirty={dirty.has(branch.id)} /></div>
        <fieldset disabled={!canEdit || !!busy} className="branch-grid">{branchFields.map(([field, label]) => <label key={field} className={['address','hours','exceptions','mapsUrl'].includes(field) ? 'wide' : ''}>{label}{field === 'mapsUrl' && <span className="field-note">Optional · paste the Google Maps share link</span>}{['address','hours','exceptions'].includes(field) ? <textarea dir="auto" rows={field === 'hours' ? 3 : 2} maxLength={10000} value={branch.value[field]} onChange={e => { setBranches(all => all.map(b => b.id === branch.id ? { ...b, value: { ...b.value, [field]: e.target.value } } : b)); mark(branch.id); }} /> : <input dir="auto" type={field === 'mapsUrl' ? 'url' : 'text'} maxLength={field === 'mapsUrl' ? 2048 : field === 'name' ? 200 : 100} value={branch.value[field]} onChange={e => { setBranches(all => all.map(b => b.id === branch.id ? { ...b, value: { ...b.value, [field]: e.target.value } } : b)); mark(branch.id); }} />}</label>)}</fieldset>
        <SaveActions disabled={!canEdit || !!busy} saving={busy === branch.id && !deleting} deleting={busy === branch.id && deleting} onSave={() => void save('branch', branch.id)} onDelete={() => void remove('branch', branch.id)} />{feedbackId === branch.id && (error || notice) && <p className={error ? 'error' : 'success'} role={error ? 'alert' : 'status'}>{error || notice}</p>}
      </article>) : faqs.map((faq, i) => <article className="entry-card" key={faq.id}><div className="card-heading"><div className="card-number">{String(i+1).padStart(2,'0')}</div><h3>Customer question</h3><Badge published={faq.is_published} dirty={dirty.has(faq.id)} /></div><fieldset disabled={!canEdit || !!busy}><label>Question<textarea dir="auto" rows={2} maxLength={1000} value={faq.question} onChange={e => { setFaqs(all => all.map(f => f.id === faq.id ? { ...f, question: e.target.value } : f)); mark(faq.id); }} /></label><label>Your answer<textarea dir="auto" rows={4} maxLength={10000} value={faq.answer} onChange={e => { setFaqs(all => all.map(f => f.id === faq.id ? { ...f, answer: e.target.value } : f)); mark(faq.id); }} /></label></fieldset><SaveActions disabled={!canEdit || !!busy} saving={busy === faq.id && !deleting} deleting={busy === faq.id && deleting} onSave={() => void save('faq', faq.id)} onDelete={() => void remove('faq', faq.id)} />{feedbackId === faq.id && (error || notice) && <p className={error ? 'error' : 'success'} role={error ? 'alert' : 'status'}>{error || notice}</p>}</article>)}</div>
    </>}
    <footer className="editor-footer">Your answers stay within your business workspace. Only approved entries are available for assistant use.</footer>
  </main>;
}
function newBranch(): Branch { const id = crypto.randomUUID(); return { id, fact_key: `branch:${id}`, value: emptyBranch(), is_published: false }; }
function Badge({ published, dirty }: { published: boolean; dirty: boolean }) { return <span className={`badge ${published && !dirty ? 'approved' : ''}`}>{dirty ? 'Unsaved changes' : published ? 'Approved' : 'Draft'}</span>; }
function SaveActions({ disabled, saving, deleting, onSave, onDelete }: { disabled: boolean; saving: boolean; deleting: boolean; onSave: () => void; onDelete: () => void }) {
  return <div className="save-actions"><button type="button" className="primary" disabled={disabled} onClick={onSave}>{saving ? 'Saving…' : 'Save'}</button><button type="button" className="secondary delete-button" disabled={disabled} onClick={onDelete}>{deleting ? 'Deleting…' : 'Delete'}</button></div>;
}

function PasswordForm({ db, onDone }: { db: SupabaseClient; onDone: () => void }) {
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  async function update(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const values = new FormData(form);
    const password = String(values.get('password'));
    if (password !== values.get('confirmation')) { setError('The passwords do not match.'); return; }
    setBusy(true); setError('');
    try {
      const { error } = await db.auth.updateUser({ password });
      if (error) setError('Could not update the password. Use a stronger password, or sign in again and retry.');
      else { form.reset(); setDone(true); }
    } catch { setError('Could not connect. Please try again.'); } finally { setBusy(false); }
  }
  return <form className="login-card" onSubmit={update}><h2>Choose your password</h2>
    {done ? <><p className="success" role="status">Your password has been updated.</p><button type="button" className="secondary" onClick={onDone}>Close</button></> : <>
      <label>New password<input name="password" type="password" autoComplete="new-password" minLength={6} maxLength={128} required disabled={busy} /></label>
      <label>Confirm new password<input name="confirmation" type="password" autoComplete="new-password" minLength={6} maxLength={128} required disabled={busy} /></label>
      <p style={{marginTop:10}}>Use at least 6 characters.</p>{error && <p className="error" role="alert">{error}</p>}
      <button className="primary" disabled={busy}>{busy ? 'Updating…' : 'Update password'}</button><button type="button" className="text-button" disabled={busy} onClick={onDone}>Cancel</button>
    </>}
  </form>;
}
