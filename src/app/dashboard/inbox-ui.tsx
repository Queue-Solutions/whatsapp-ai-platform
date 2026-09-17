'use client';
import {useEffect,useMemo,useRef,useState} from 'react';
import {useSearchParams} from 'next/navigation';
import {GapFaqEditor} from './gap-faq-editor';
import type {SupabaseClient} from '@supabase/supabase-js';
import {KnowledgeEditor,type Membership} from '@/modules/admin/knowledge-editor';
import {InboxRepository,attentionReason,conversationStateLabel,waitingLabel,type AttentionAction,type Conversation,type InboxCounts,type InboxFilter,type InboxMessage,type InboxEvent} from '@/modules/admin/inbox';

const filters: {id:InboxFilter;label:string;empty:string}[] = [
  {id:'all',label:'All',empty:'No conversations yet. New WhatsApp messages will appear here.'},
  {id:'attention',label:'Needs attention',empty:'You’re all caught up. Conversations that need you will appear here.'},
  {id:'complaints',label:'Complaints',empty:'No complaints flagged. You can also mark a conversation manually.'},
  {id:'resolved',label:'Resolved',empty:'Conversations you resolve will appear here. Their messages stay available.'},
];


export function Inbox({db}:{db:SupabaseClient}){
  const params=useSearchParams();
  const repository=useMemo(()=>new InboxRepository(db),[db]);
  const knowledgeEditor=useMemo(()=>new KnowledgeEditor(db),[db]);
  const [memberships,setMemberships]=useState<Membership[]>([]);const [tenant,setTenant]=useState('');
  const [filter,setFilter]=useState<InboxFilter>(params.get('filter')==='attention'?'attention':'all');
  const [limit,setLimit]=useState(50);
  const [counts,setCounts]=useState<InboxCounts>({all:0,attention:0,complaints:0,resolved:0});
  const [conversations,setConversations]=useState<Conversation[]>([]);const [selected,setSelected]=useState('');
  const [draftDirty,setDraftDirty]=useState(false);const [working,setWorking]=useState(false);
  const [now,setNow]=useState(()=>Date.now());
  useEffect(()=>{const warn=(e:BeforeUnloadEvent)=>{if(draftDirty){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[draftDirty]);
  const discard=()=>!draftDirty||window.confirm('Discard unsaved changes in this conversation?');
  const [error,setError]=useState('');const [loading,setLoading]=useState(true);const [refresh,setRefresh]=useState(0);
  useEffect(()=>{let active=true;void new KnowledgeEditor(db).memberships().then(rows=>{if(active){setMemberships(rows);setTenant(rows[0]?.tenant_id??'');if(!rows.length)setLoading(false);}}).catch(()=>{if(active){setError('Could not load business access.');setLoading(false);}});return()=>{active=false;};},[db]);
  useEffect(()=>{
    if(!tenant)return;let active=true;let running=false;
    const load=async()=>{
      if(running)return;running=true;
      try{
        const [rows,totals]=await Promise.all([repository.conversations(tenant,filter,limit),repository.counts(tenant)]);
        if(active){setConversations(rows);setCounts(totals);setSelected(id=>rows.some(c=>c.id===id)?id:rows[0]?.id??'');setError('');setNow(Date.now());}
      }catch{if(active)setError('Could not refresh conversations. Check your connection and try again.');}
      finally{running=false;if(active)setLoading(false);}
    };
    void load();const timer=setInterval(()=>void load(),10000);return()=>{active=false;clearInterval(timer);};
  },[repository,tenant,filter,limit,refresh]);
  const current=conversations.find(c=>c.id===selected);
  const canEdit=['owner','admin','agent'].includes(memberships.find(m=>m.tenant_id===tenant)?.role??'');
  const canEditFaq=['owner','admin'].includes(memberships.find(m=>m.tenant_id===tenant)?.role??'');
  function changeFilter(next:InboxFilter){
    if(filter===next||!discard())return;
    setDraftDirty(false);setSelected('');setConversations([]);setFilter(next);setLimit(50);setLoading(true);
  }
  return <main className="content inbox-content">
    <div className="page-title"><div><div className="eyebrow">YOUR CUSTOMER CONVERSATIONS</div><h1>Inbox</h1><p className="intro">See who needs you, reply personally, and keep every issue in view.</p></div><button className="text-button" disabled={working} onClick={()=>{if(discard())void db.auth.signOut({scope:'local'});}}>Sign out</button></div>
    <div className="toolbar"><label>Business<select value={tenant} disabled={loading||working} onChange={e=>{if(!discard())return;setDraftDirty(false);setTenant(e.target.value);setConversations([]);setSelected('');setCounts({all:0,attention:0,complaints:0,resolved:0});setLimit(50);setLoading(true);}}>{memberships.map(m=><option key={m.tenant_id} value={m.tenant_id}>{m.name}</option>)}</select></label><span className="draft-count">Updates every 10 seconds</span><button className="secondary" disabled={working} onClick={()=>setRefresh(n=>n+1)}>Refresh</button></div>
    <div className="inbox-filters" role="group" aria-label="Filter conversations">{filters.map(f=><button key={f.id} aria-pressed={filter===f.id} disabled={working} onClick={()=>changeFilter(f.id)}>{f.label}<span>{counts[f.id]}</span></button>)}</div>
    {error&&<p className="error" role="alert">{error}</p>}
    {loading?<p role="status">Loading conversations…</p>:!memberships.length?<p className="notice">Your account needs business access.</p>:<div className="inbox-grid">
      <nav className="conversation-list" aria-label="Conversations"><div className="list-heading">{filters.find(f=>f.id===filter)!.label}<span>{counts[filter]}</span></div>
        {!conversations.length&&<p className="empty-inbox">{filters.find(f=>f.id===filter)!.empty}</p>}
        {conversations.map(c=><button key={c.id} aria-current={c.id===selected?'true':undefined} disabled={working} onClick={()=>{if(c.id===selected)return;if(discard()){setDraftDirty(false);setSelected(c.id);}}}>
          <strong>{c.name}</strong><span className="customer-number" dir="ltr">{c.phone?`+${c.phone}`:c.username?`@${c.username} · Phone number not shared`:'Phone number not shared'}</span><span className={`mode-label ${c.attention_state!=='none'?'human':''}`}>{conversationStateLabel(c)}</span>
          {c.is_complaint&&<span className="complaint-chip">Complaint</span>}
          {c.attention_state!=='none'&&c.attention_reason!=='complaint'&&<span className="attention-reason">{attentionReason(c.attention_reason)}</span>}
          {c.attention_summary&&<span className="conversation-summary">{c.attention_summary}</span>}
          {c.attention_state==='waiting'?<span className="waiting-time">{waitingLabel(c.attention_since,now)}</span>:<time>{formatTime(c.last_inbound_at)}</time>}
        </button>)}
        {conversations.length<counts[filter]&&<button className="load-conversations" disabled={working} onClick={()=>setLimit(n=>n+50)}>Load more conversations</button>}
      </nav>
      {current?<ConversationPanel key={`${tenant}:${current.id}`} repository={repository} knowledgeEditor={knowledgeEditor} tenant={tenant} conversation={current} canEdit={canEdit} canEditFaq={canEditFaq} onDraft={setDraftDirty} onWorking={setWorking} onRefresh={()=>setRefresh(n=>n+1)}/>:<div className="empty-conversation"><span aria-hidden="true">✓</span><h2>{filter==='attention'?'Nothing needs your attention':'Your conversations, in one place'}</h2><p>{filters.find(f=>f.id===filter)!.empty}</p></div>}
    </div>}
  </main>;
}
function ConversationPanel({repository,knowledgeEditor,tenant,conversation:c,canEdit,canEditFaq,onRefresh,onDraft,onWorking}:{repository:InboxRepository;knowledgeEditor:KnowledgeEditor;tenant:string;conversation:Conversation;canEdit:boolean;canEditFaq:boolean;onRefresh:()=>void;onDraft:(dirty:boolean)=>void;onWorking:(busy:boolean)=>void}){
  const messageList=useRef<HTMLDivElement>(null);const firstMessages=useRef(true);
  const [now,setNow]=useState(()=>Date.now());
  const [messages,setMessages]=useState<InboxMessage[]>([]);const [events,setEvents]=useState<InboxEvent[]>([]);const [limit,setLimit]=useState(100);
  const [error,setError]=useState('');const [notice,setNotice]=useState('');const [busy,setBusy]=useState(false);const [reload,setReload]=useState(0);
  const [loadedGapMessage,setGapMessage]=useState<InboxMessage|null>(null);
  const [faqTarget,setFaqTarget]=useState<{id:string;question:string}|null>(null);const [faqDirty,setFaqDirty]=useState(false);
  const [text,setText]=useState('');const [attempt,setAttempt]=useState<{id:string;text:string;blocked:boolean}|null>(null);
  useEffect(()=>{onDraft(!!text||faqDirty);},[text,faqDirty,onDraft]);
  useEffect(()=>{let active=true;if(c.attention_message_id)void repository.attentionMessage(tenant,c.id,c.attention_message_id).then(value=>{if(active)setGapMessage(value);}).catch(e=>{if(active)setError((e as Error).message);});return()=>{active=false;};},[repository,tenant,c.id,c.attention_message_id,reload]);
  useEffect(()=>{let active=true;let running=false;const load=async()=>{if(running)return;running=true;try{const [m,e]=await Promise.all([repository.messages(tenant,c.id,limit),repository.events(tenant,c.id)]);if(active){setMessages(m);setEvents(e);setNow(Date.now());}}catch{if(active)setError('Could not refresh messages. Use Refresh to try again.');}finally{running=false;}};void load();const timer=setInterval(()=>void load(),10000);return()=>{active=false;clearInterval(timer);};},[repository,tenant,c.id,limit,reload]);
  useEffect(()=>{const el=messageList.current;if(!el||!messages.length)return;if(firstMessages.current||el.scrollHeight-el.scrollTop-el.clientHeight<100)el.scrollTop=el.scrollHeight;firstMessages.current=false;},[messages]);
  const gapMessage=loadedGapMessage?.id===c.attention_message_id?loadedGapMessage:null;
  const canSend=!c.blocked&&canEdit&&c.automation_mode==='human'&&c.attention_state==='in_progress'&&c.status==='open'&&Date.parse(c.last_inbound_at)>now-(23*60+55)*60000;
  async function action(value:AttentionAction){
    const clearsDraft=['resolve','resume'].includes(value);
    if(clearsDraft&&(text||faqDirty)&&!window.confirm('Discard unsaved changes and continue?'))return false;
    setBusy(true);onWorking(true);setError('');setNotice('');
    try{
      await repository.attention(c,value);
      if(clearsDraft){setText('');setAttempt(null);setFaqTarget(null);setFaqDirty(false);}
      setNotice(({reply:'You’re replying personally. The assistant stays paused. A reply already being sent may still arrive.',resolve:c.attention_reason==='knowledge_gap'&&c.automation_mode==='auto'?'Review resolved. The assistant remains on. A new unanswered business question will flag this conversation again.':'Resolved. The assistant stays paused. A new customer message will bring this conversation back to Needs attention.',resume:'Assistant resumed for new messages. Earlier messages will not be replayed.',flag:'Added to Needs attention. The assistant is paused.',complaint:'Marked as a complaint. The assistant is paused.',remove_complaint:'Complaint label removed. The assistant mode has not changed.'})[value]);
      onRefresh();setReload(n=>n+1);return true;
    }catch(e){setError((e as Error).message);onRefresh();return false;}finally{setBusy(false);onWorking(false);}
  }
  async function send(event:React.FormEvent){event.preventDefault();if(!canSend||busy||!text.trim()||attempt?.blocked)return;
    const pending=attempt??{id:crypto.randomUUID(),text:text.trim(),blocked:false};setAttempt(pending);setBusy(true);onWorking(true);setError('');setNotice('');
    try{const state=await repository.send(c.id,pending.id,pending.text);
      if(state==='sent'){setText('');setAttempt(null);setNotice('Reply sent. Delivery status appears below the message.');}
      else{setAttempt({...pending,blocked:true});setNotice(state==='failed'?'Sending failed. Check the message status and resolve the connection before composing another reply.':'This reply may have been sent. Check WhatsApp before composing another reply; it will not be retried automatically.');}
    }catch(e){setAttempt({...pending,blocked:true});setError(`${(e as Error).message} Check the message list before composing another reply.`);}
    finally{setBusy(false);onWorking(false);setReload(n=>n+1);onRefresh();}
  }
  const disabled=!!c.blocked||!canEdit||busy||c.status!=='open';
  async function prepareFaqReply(answer:string){
    if(text&&!window.confirm('Replace your unsent reply with the saved FAQ answer?'))return;
    if(await action('reply')){setText(answer.slice(0,4096));setAttempt(null);setFaqTarget(null);setFaqDirty(false);setNotice(answer.length>4096?'FAQ saved. The answer was shortened to fit a WhatsApp reply; review it before sending.':'FAQ saved. Review your personal reply below and choose Send reply when ready.');}
  }
  function closeFaq(){if(!faqDirty||window.confirm('Discard the unsaved FAQ changes?')){setFaqTarget(null);setFaqDirty(false);}}

  return <section className="conversation-panel" aria-label={`Conversation with ${c.name}`}>
    <div className="conversation-header"><div><h2>{c.name}</h2><span className="customer-number" dir="ltr">{c.phone?<a href={`tel:+${c.phone}`}>+{c.phone}</a>:c.username?`@${c.username} · Phone number not shared`:'Phone number not shared'}</span><span className={`mode-label ${c.automation_mode==='human'?'human':''}`}>{conversationStateLabel(c)}</span>{c.is_complaint&&<span className="complaint-chip">Complaint</span>}</div>
      <div className="conversation-controls">
        {c.attention_state!=='in_progress'&&<button className="primary" disabled={disabled} onClick={()=>void action('reply')}>Reply personally</button>}
        {c.attention_state!=='resolved'&&<button className="secondary" disabled={disabled} onClick={()=>void action('resolve')}>Resolve</button>}
        {c.automation_mode==='human'&&<button className="secondary" disabled={disabled} onClick={()=>void action('resume')}>Return to assistant</button>}
      </div>
    </div>
    {c.blocked&&<p className="notice">This customer is blacklisted. <a href="/dashboard/blacklist">Review the block</a> before replying or resuming the assistant.</p>}
    <div className={`attention-detail ${c.attention_state==='resolved'?'is-resolved':''}`}>
      {c.attention_state!=='none'&&<div><strong>{attentionReason(c.attention_reason)}</strong><p dir="auto">{c.attention_summary||'You’re handling this conversation personally.'}</p>{c.attention_reason==='knowledge_gap'&&<div className="knowledge-gap-details">{gapMessage?.body&&<><span className="gap-detail-label">Latest unanswered question</span><blockquote dir="auto">{gapMessage.body}</blockquote></>}<p><b>Suggested next step:</b> Check the saved information, confirm the answer, then reply or add it to FAQs.</p><p>{c.automation_mode==='auto'?c.attention_state==='resolved'?'This review is resolved. The assistant can answer new questions.':'The assistant can still answer other questions. This flag stays until you resolve it.':'The assistant is paused while you handle this conversation.'}</p>{canEditFaq&&gapMessage?.body&&<button className="secondary" disabled={disabled||!!faqTarget} onClick={()=>setFaqTarget({id:gapMessage.id,question:gapMessage.body!})}>Add to FAQs</button>}</div>}<span>{c.attention_state==='waiting'?waitingLabel(c.attention_since,now):c.attention_state==='resolved'?`Resolved ${formatTime(c.resolved_at!)}`:'In progress · You’re replying personally'}</span></div>}
      <div className="flag-actions"><button className="text-button" disabled={disabled} onClick={()=>void action(c.is_complaint?'remove_complaint':'complaint')}>{c.is_complaint?'Remove complaint label':'Mark as complaint'}</button>{c.attention_state!=='waiting'&&<button className="text-button" disabled={disabled} onClick={()=>void action('flag')}>Needs human</button>}</div>
    </div>
    {c.followup_state!=='none'&&<section className="followup-card" aria-label="Personal follow-up">
      <strong>{c.followup_purpose==='career'?'Job application':'Personal follow-up'}</strong>
      <p>{c.attention_state==='resolved'?'This follow-up is marked resolved.':c.followup_state==='ready'?(c.followup_purpose==='career'?'Application details are ready. Contact this applicant only if the desired role is needed.':'Ready for personal contact. Please contact this customer shortly.'):c.followup_state==='declined'?'The customer chose not to share contact details. You can reply in this conversation.':c.automation_mode==='human'?'Contact details are incomplete. The assistant is paused, so you can collect them personally.':c.followup_purpose==='career'&&!c.followup_role?'Waiting for the applicant’s desired job role.':'Waiting for the customer’s name and contact number. The assistant is collecting these details.'}</p>
      <dl>{c.followup_purpose==='career'&&<div><dt>Desired role</dt><dd dir="auto">{c.followup_role||'Not provided yet'}</dd></div>}<div><dt>Name</dt><dd dir="auto">{c.followup_name||'Not provided yet'}</dd></div><div><dt>Phone</dt><dd dir="ltr">{c.followup_phone?<a href={`tel:+${c.followup_phone}`}>+{c.followup_phone}</a>:'Not provided yet'}</dd></div></dl>
      {c.followup_purpose!=='career'&&c.followup_state==='ready'&&c.attention_state!=='resolved'&&<p>Contact the customer personally, then mark the conversation resolved.</p>}
    </section>}
    {c.attention_state==='resolved'&&<p className="resolved-note">{c.automation_mode==='auto'?'This review is resolved. The assistant is on.':'This issue is marked resolved. The assistant stays paused until you return the conversation to it.'}</p>}
    {faqTarget&&<GapFaqEditor key={faqTarget.id} editor={knowledgeEditor} tenant={tenant} messageId={faqTarget.id} question={faqTarget.question} onClose={closeFaq} onPrepare={prepareFaqReply} onDirty={setFaqDirty} onWorking={value=>{setBusy(value);onWorking(value);}}/>}
    <div ref={messageList} className="message-list" aria-label="Messages">{messages.length>=limit&&limit<500&&<button className="text-button" onClick={()=>setLimit(n=>n+100)}>Load older messages</button>}{!messages.length&&<p className="empty-inbox">No messages to show.</p>}{messages.map(m=><article key={m.id} className={`message-bubble ${m.direction}`}><p dir="auto">{m.body||`[${m.message_type} message]`}</p><div className="message-meta"><time>{formatTime(m.created_at)}</time>{m.direction==='outbound'&&<span>{deliveryLabel(m.delivery_status)}</span>}</div></article>)}</div>
    <div className="reply-area">{!canEdit?<p className="notice">This account has read-only access.</p>:<form onSubmit={send}><label>Your reply<textarea dir="auto" rows={3} maxLength={4096} value={text} onChange={e=>{setText(e.target.value);setAttempt(null);}} disabled={!canSend||busy||!!attempt?.blocked} placeholder={c.attention_state!=='in_progress'?'Choose “Reply personally” to write a reply.':'Write your reply…'}/></label><div className="composer-actions"><span>{c.attention_state!=='in_progress'?'Reply personally pauses the assistant for this conversation.':!canSend?'Wait for a new customer message to reopen the reply window.':'Your reply goes directly to this WhatsApp conversation.'}</span>{attempt?.blocked?<button type="button" className="secondary" onClick={()=>{setAttempt(null);setText('');setNotice('');setError('');}}>Compose another reply</button>:<button className="primary" disabled={!canSend||busy||!text.trim()}>{busy?'Working…':'Send reply'}</button>}</div></form>}
      {error&&<p className="error" role="alert">{error}</p>}{notice&&<p className="success" role="status">{notice}</p>}
      {!!events.length&&<details className="conversation-activity"><summary>Conversation activity</summary><ul>{events.map(e=><li key={e.id}>{eventLabel(e.event_type)} · {formatTime(e.created_at)}</li>)}</ul></details>}
    </div>
  </section>;
}
function formatTime(value:string){return new Date(value).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});}
function deliveryLabel(status:string){return ({sending:'Sending',sent:'Sent',delivered:'Delivered',read:'Read',failed:'Failed',needs_review:'Delivery uncertain · check WhatsApp',queued:'Queued'} as Record<string,string>)[status]??status;}
function eventLabel(type:string){return ({knowledge_gap:'Missing business information flagged',paused:'Assistant paused',resumed:'Returned to assistant',manual_reply:'Personal reply prepared',human_requested:'Customer requested a person',complaint:'Flagged as a complaint',flagged:'Marked for your attention',reply_personally:'Replying personally',resolved:'Marked resolved',complaint_removed:'Complaint label removed',customer_follow_up:'Reopened after a customer message'} as Record<string,string>)[type]??'Conversation updated';}
