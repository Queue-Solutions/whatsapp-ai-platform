'use client';
import {useEffect,useMemo,useState} from 'react';
import type {SupabaseClient} from '@supabase/supabase-js';
import {KnowledgeEditor,type Membership} from '@/modules/admin/knowledge-editor';
import {BlacklistRepository,categoryLabel,type BlacklistEntry,type BlockState} from '@/modules/admin/blacklist';
export function Blacklist({db}:{db:SupabaseClient}){
  const repository=useMemo(()=>new BlacklistRepository(db),[db]);
  const [memberships,setMemberships]=useState<Membership[]>([]),[tenant,setTenant]=useState(''),[state,setState]=useState<BlockState>('pending_review');
  const [entries,setEntries]=useState<BlacklistEntry[]>([]),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[refresh,setRefresh]=useState(0),[limit,setLimit]=useState(50);
  useEffect(()=>{let active=true;void new KnowledgeEditor(db).memberships().then(m=>{if(active){setMemberships(m);setTenant(m[0]?.tenant_id??'');if(!m.length)setLoading(false);}}).catch(()=>{if(active){setError('Could not load business access.');setLoading(false);}});return()=>{active=false;};},[db]);
  useEffect(()=>{if(!tenant)return;let active=true;void repository.list(tenant,state,limit).then(rows=>{if(active)setEntries(rows);}).catch(e=>{if(active)setError((e as Error).message);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[repository,tenant,state,refresh,limit]);
  const canReview=['owner','admin'].includes(memberships.find(m=>m.tenant_id===tenant)?.role??'');
  async function review(entry:BlacklistEntry,action:'kept'|'removed'){
    setBusy(true);setError('');setNotice('');
    try{await repository.review(tenant,entry,action);window.dispatchEvent(new Event('blacklist-updated'));setNotice(action==='kept'?'Block kept. This customer will stay blocked.':'Block removed. New messages can be handled using the conversation’s existing assistant setting. Old messages will not be replayed.');setLoading(true);setRefresh(n=>n+1);}catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  return <main className="content blacklist-content"><div className="eyebrow">CUSTOMER SAFETY</div><h1>Blacklist</h1><p className="intro">Review customers flagged for sexual content, threats or targeted abuse. Replies are blocked while a review is pending.</p>
    {memberships.length>1&&<label>Business<select value={tenant} disabled={busy} onChange={e=>{setLoading(true);setError('');setTenant(e.target.value);setNotice('');}}>{memberships.map(m=><option key={m.tenant_id} value={m.tenant_id}>{m.name}</option>)}</select></label>}
    <div className="inbox-toolbar"><div className="inbox-filters" role="group" aria-label="Blacklist status">{([['pending_review','Needs review'],['kept','Kept blocked'],['removed','Unblocked']] as const).map(([id,label])=><button key={id} aria-pressed={state===id} disabled={busy} onClick={()=>{setLoading(true);setError('');setState(id);setLimit(50);setNotice('');}}>{label}</button>)}</div><button className="secondary" disabled={busy||loading} onClick={()=>{setError('');setLoading(true);setRefresh(n=>n+1);}}>Refresh</button></div>
    {error&&<p className="error" role="alert">{error}</p>}{notice&&<p className="success" role="status">{notice}</p>}
    {loading?<p role="status">Loading reviews…</p>:!memberships.length?<p className="notice">Your account needs business access.</p>:!error&&!entries.length?<div className="blacklist-empty"><span aria-hidden="true">✓</span><h2>{state==='pending_review'?'No customers waiting for review':'No customers in this list'}</h2><p>Flagged conversations will appear here with the reason for the block.</p></div>:<div className="blacklist-list">{entries.map(entry=><article className="blacklist-card" key={`${tenant}:${entry.customer_id}:${entry.revision}`}><header><div><h2>{entry.name}</h2><span className="customer-number" dir="ltr">{entry.phone?`+${entry.phone}`:entry.username?`@${entry.username} · Phone number not shared`:'Phone number not shared'}</span></div><span className={`block-chip ${entry.state}`}>{entry.state==='pending_review'?'Blocked · Needs review':entry.state==='kept'?'Block kept':'Unblocked'}</span></header>
      <p className="blacklist-reason"><strong>Why this was flagged</strong><br/>{entry.categories.map(categoryLabel).join(' · ')} detected in {entry.message_type==='image'?'an image or its caption':'a message'}. This is an automated assessment for you to review.</p>
      <details className="blacklist-evidence"><summary>Review flagged content</summary>{entry.body&&<blockquote dir="auto">{entry.body}</blockquote>}{entry.message_type==='image'&&<ReviewImage repository={repository} message={entry.message_id}/>}</details>
      <footer><time>{new Date(entry.updated_at).toLocaleString()}</time>{entry.state!=='removed'&&canReview&&<div className="blacklist-actions">{entry.state==='pending_review'&&<button className="secondary" disabled={busy} onClick={()=>void review(entry,'kept')}>Keep blocked</button>}<button className="primary" disabled={busy} onClick={()=>void review(entry,'removed')}>Remove block</button></div>}</footer>
      {!canReview&&entry.state!=='removed'&&<p className="notice">An administrator can keep or remove this block.</p>}
    </article>)}{entries.length>=limit&&<button className="secondary" disabled={busy} onClick={()=>{setLoading(true);setError('');setLimit(n=>n+50);}}>Load more</button>}</div>}
    <p className="blacklist-note">Blocks apply to replies from this dashboard and assistant. A reply already being sent may still arrive. Removing a block keeps the conversation’s previous assistant setting.</p>
  </main>;
}
function ReviewImage({repository,message}:{repository:BlacklistRepository;message:string}){
  const [url,setUrl]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>()=>{if(url)URL.revokeObjectURL(url);},[url]);
  async function reveal(){setBusy(true);setError('');try{const blob=await repository.image(message);setUrl(URL.createObjectURL(blob));}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  return <div className="review-image">{url?<>{/* Authenticated blob URL, never a remote image URL. */}
{/* eslint-disable-next-line @next/next/no-img-element */}
<img src={url} alt="Flagged WhatsApp image for admin review"/><button className="text-button" onClick={()=>setUrl('')}>Hide image</button></>:<><p>This image may contain explicit content.</p><button className="secondary" disabled={busy} onClick={()=>void reveal()}>{busy?'Loading image…':'Reveal image'}</button></>}{error&&<p role="alert" className="error">{error}</p>}</div>;
}
