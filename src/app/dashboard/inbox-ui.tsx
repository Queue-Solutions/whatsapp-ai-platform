'use client';
import {useEffect,useMemo,useRef,useState} from 'react';
import type {SupabaseClient} from '@supabase/supabase-js';
import {KnowledgeEditor,type Membership} from '@/modules/admin/knowledge-editor';
import {InboxRepository,type Conversation,type InboxMessage,type InboxEvent} from '@/modules/admin/inbox';

export function Inbox({db}:{db:SupabaseClient}){
  const repository=useMemo(()=>new InboxRepository(db),[db]);
  const [memberships,setMemberships]=useState<Membership[]>([]);const [tenant,setTenant]=useState('');
  const [conversations,setConversations]=useState<Conversation[]>([]);const [selected,setSelected]=useState('');
  const [draftDirty,setDraftDirty]=useState(false);const [working,setWorking]=useState(false);
  useEffect(()=>{const warn=(e:BeforeUnloadEvent)=>{if(draftDirty){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[draftDirty]);
  const discard=()=>!draftDirty||window.confirm('Discard this unsent reply?');
  const [error,setError]=useState('');const [loading,setLoading]=useState(true);const [refresh,setRefresh]=useState(0);
  useEffect(()=>{let active=true;void new KnowledgeEditor(db).memberships().then(rows=>{if(active){setMemberships(rows);setTenant(rows[0]?.tenant_id??'');if(!rows.length)setLoading(false);}}).catch(()=>{if(active){setError('Could not load business access.');setLoading(false);}});return()=>{active=false;};},[db]);
  useEffect(()=>{
    if(!tenant)return;let active=true;let running=false;
    const load=async()=>{if(running)return;running=true;try{const rows=await repository.conversations(tenant);if(active){setConversations(rows);setSelected(id=>rows.some(c=>c.id===id)?id:rows[0]?.id??'');setError('');}}catch{if(active)setError('Could not refresh conversations. Check your connection and try again.');}finally{running=false;if(active)setLoading(false);}};
    void load();const timer=setInterval(()=>void load(),10000);return()=>{active=false;clearInterval(timer);};
  },[repository,tenant,refresh]);
  const current=conversations.find(c=>c.id===selected);
  const canEdit=['owner','admin','agent'].includes(memberships.find(m=>m.tenant_id===tenant)?.role??'');
  return <main className="content inbox-content"><div className="page-title"><div><div className="eyebrow">KEEP THE CONVERSATION GOING</div><h1>Inbox</h1><p className="intro">See replies, take over when needed, and hand back to your assistant.</p></div><button className="text-button" disabled={working} onClick={()=>{if(discard())void db.auth.signOut({scope:'local'});}}>Sign out</button></div>
    <div className="toolbar"><label>Business<select value={tenant} disabled={loading||working} onChange={e=>{if(!discard())return;setDraftDirty(false);setTenant(e.target.value);setConversations([]);setSelected('');setLoading(true);}}>{memberships.map(m=><option key={m.tenant_id} value={m.tenant_id}>{m.name}</option>)}</select></label><span className="draft-count">Refreshes every 10 seconds</span><button className="secondary" onClick={()=>setRefresh(n=>n+1)}>Refresh</button></div>
    {error&&<p className="error" role="alert">{error}</p>}
    {loading?<p role="status">Loading conversations…</p>:!memberships.length?<p className="notice">Your account needs business access.</p>:<div className="inbox-grid"><nav className="conversation-list" aria-label="Recent conversations"><div className="list-heading">Recent conversations <span>{conversations.length}</span></div>{!conversations.length&&<p className="empty-inbox">No conversations yet. New WhatsApp messages will appear here.</p>}{conversations.map(c=><button key={c.id} aria-current={c.id===selected?'true':undefined} disabled={working} onClick={()=>{if(c.id===selected)return;if(discard()){setDraftDirty(false);setSelected(c.id);}}}><strong>{c.name}</strong><span className={`mode-label ${c.automation_mode==='human'?'human':''}`}>{c.automation_mode==='human'?'Needs your team':'Assistant on'}</span><time>{formatTime(c.last_inbound_at)}</time></button>)}<p className="empty-inbox">Showing up to 50 recent conversations.</p></nav>
      {current?<ConversationPanel key={`${tenant}:${current.id}`} repository={repository} tenant={tenant} conversation={current} canEdit={canEdit} onDraft={setDraftDirty} onWorking={setWorking} onRefresh={()=>setRefresh(n=>n+1)}/>:<div className="empty-state">Select a conversation to see its messages.</div>}
    </div>}
  </main>;
}
function ConversationPanel({repository,tenant,conversation:c,canEdit,onRefresh,onDraft,onWorking}:{repository:InboxRepository;tenant:string;conversation:Conversation;canEdit:boolean;onRefresh:()=>void;onDraft:(dirty:boolean)=>void;onWorking:(busy:boolean)=>void}){
  const messageList=useRef<HTMLDivElement>(null);const firstMessages=useRef(true);
  const [now,setNow]=useState(()=>Date.now());
  const [messages,setMessages]=useState<InboxMessage[]>([]);const [events,setEvents]=useState<InboxEvent[]>([]);const [limit,setLimit]=useState(100);
  const [error,setError]=useState('');const [notice,setNotice]=useState('');const [busy,setBusy]=useState(false);const [reload,setReload]=useState(0);
  const [text,setText]=useState('');const [attempt,setAttempt]=useState<{id:string;text:string;blocked:boolean}|null>(null);
  useEffect(()=>{let active=true;let running=false;const load=async()=>{if(running)return;running=true;try{const [m,e]=await Promise.all([repository.messages(tenant,c.id,limit),repository.events(tenant,c.id)]);if(active){setMessages(m);setEvents(e);setNow(Date.now());}}catch{if(active)setError('Could not refresh messages. Use Refresh to try again.');}finally{running=false;}};void load();const timer=setInterval(()=>void load(),10000);return()=>{active=false;clearInterval(timer);};},[repository,tenant,c.id,limit,reload]);
  useEffect(()=>{const el=messageList.current;if(!el||!messages.length)return;if(firstMessages.current||el.scrollHeight-el.scrollTop-el.clientHeight<100)el.scrollTop=el.scrollHeight;firstMessages.current=false;},[messages]);
  const canSend=canEdit&&c.automation_mode==='human'&&c.status==='open'&&Date.parse(c.last_inbound_at)>now-(23*60+55)*60000;
  async function mode(){setBusy(true);onWorking(true);setError('');setNotice('');try{await repository.mode(c,c.automation_mode==='auto'?'human':'auto');setNotice(c.automation_mode==='auto'?'Assistant paused. You can reply below. A reply already being sent may still arrive.':'Assistant resumed for new messages. Earlier messages will not be replayed.');onRefresh();setReload(n=>n+1);}catch(e){setError((e as Error).message);}finally{setBusy(false);onWorking(false);}}
  async function send(event:React.FormEvent){event.preventDefault();if(!canSend||busy||!text.trim()||attempt?.blocked)return;
    const pending=attempt??{id:crypto.randomUUID(),text:text.trim(),blocked:false};setAttempt(pending);setBusy(true);onWorking(true);setError('');setNotice('');
    try{const state=await repository.send(c.id,pending.id,pending.text);
      if(state==='sent'){setText('');onDraft(false);setAttempt(null);setNotice('Reply sent. Delivery status appears below the message.');}
      else{setAttempt({...pending,blocked:true});setNotice(state==='failed'?'Sending failed. Check the message status and resolve the connection before composing another reply.':'This reply may have been sent. Check WhatsApp before composing another reply; it will not be retried automatically.');}
    }catch(e){setAttempt({...pending,blocked:true});setError(`${(e as Error).message} Check the message list before composing another reply.`);}
    finally{setBusy(false);onWorking(false);setReload(n=>n+1);onRefresh();}
  }
  return <section className="conversation-panel" aria-label={`Conversation with ${c.name}`}><div className="conversation-header"><div><h2>{c.name}</h2><span className={`mode-label ${c.automation_mode==='human'?'human':''}`}>{c.automation_mode==='human'?'Assistant paused · Team replying':'Assistant on'}</span></div><button className="secondary" disabled={!canEdit||busy||c.status!=='open'} onClick={()=>void mode()}>{c.automation_mode==='auto'?'Pause assistant':'Resume assistant'}</button></div>
    <div ref={messageList} className="message-list" aria-label="Messages">{messages.length>=limit&&limit<500&&<button className="text-button" onClick={()=>setLimit(n=>n+100)}>Load older messages</button>}{!messages.length&&<p className="empty-inbox">No messages to show.</p>}{messages.map(m=><article key={m.id} className={`message-bubble ${m.direction}`}><p dir="auto">{m.body||`[${m.message_type} message]`}</p><div className="message-meta"><time>{formatTime(m.created_at)}</time>{m.direction==='outbound'&&<span>{deliveryLabel(m.delivery_status)}</span>}</div></article>)}</div>
    <div className="reply-area">{!canEdit?<p className="notice">You have read-only access. An owner, admin or agent can reply.</p>:<form onSubmit={send}><label>Your reply<textarea dir="auto" rows={3} maxLength={4096} value={text} onChange={e=>{setText(e.target.value);onDraft(!!e.target.value);setAttempt(null);}} disabled={!canSend||busy||!!attempt?.blocked} placeholder={c.automation_mode==='auto'?'Pause the assistant to reply yourself.':'Write your reply…'}/></label><div className="composer-actions"><span>{c.automation_mode==='auto'?'Pause affects this conversation only.':!canSend?'Wait for a new customer message to reopen the reply window.':'Your reply goes directly to this WhatsApp conversation.'}</span>{attempt?.blocked?<button type="button" className="secondary" onClick={()=>{setAttempt(null);setText('');onDraft(false);setNotice('');setError('');}}>Compose another reply</button>:<button className="primary" disabled={!canSend||busy||!text.trim()}>{busy?'Working…':'Send reply'}</button>}</div></form>}
      {error&&<p className="error" role="alert">{error}</p>}{notice&&<p className="success" role="status">{notice}</p>}
      {!!events.length&&<details className="conversation-activity"><summary>Recent team activity</summary><ul>{events.map(e=><li key={e.id}>{e.event_type==='paused'?'Assistant paused':e.event_type==='resumed'?'Assistant resumed':'Team reply prepared'} · {formatTime(e.created_at)}</li>)}</ul></details>}
    </div></section>;
}
function formatTime(value:string){return new Date(value).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});}
function deliveryLabel(status:string){return ({sending:'Sending',sent:'Sent',delivered:'Delivered',read:'Read',failed:'Failed',needs_review:'Delivery uncertain · check WhatsApp',queued:'Queued'} as Record<string,string>)[status]??status;}
