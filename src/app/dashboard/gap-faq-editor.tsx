'use client';
import {useEffect,useState} from 'react';
import type {KnowledgeEditor} from '@/modules/admin/knowledge-editor';
import type {Faq} from '@/modules/knowledge/questionnaire';

export function GapFaqEditor({editor,tenant,messageId,question,onClose,onPrepare,onDirty,onWorking}:{
  editor:KnowledgeEditor;tenant:string;messageId:string;question:string;onClose:()=>void;
  onPrepare:(answer:string)=>Promise<void>;onDirty:(dirty:boolean)=>void;onWorking:(busy:boolean)=>void;
}) {
  const [faq,setFaq]=useState<(Faq & {locale:string})|null>(null);
  const [error,setError]=useState('');const [busy,setBusy]=useState(false);const [saved,setSaved]=useState(false);
  useEffect(()=>{let active=true;void editor.faqForGap(tenant,messageId,question).then(value=>{if(active)setFaq(value);}).catch(e=>{if(active)setError((e as Error).message);});return()=>{active=false;};},[editor,tenant,messageId,question]);
  async function save(event:React.FormEvent){
    event.preventDefault();if(!faq||busy)return;setBusy(true);onWorking(true);setError('');
    try{const result=await editor.saveFaq(tenant,faq.locale,faq,true);setFaq({...result,locale:faq.locale});setSaved(true);onDirty(false);}
    catch(e){setError((e as Error).message);}finally{setBusy(false);onWorking(false);}
  }
  return <section className="gap-faq-editor" aria-label="Add unanswered question to FAQs">
    <div className="gap-faq-heading"><h3>{saved?'FAQ saved':'Add to FAQs'}</h3><button type="button" className="text-button" disabled={busy} onClick={onClose}>Close</button></div>
    <p>Review the question and write the confirmed answer. Saving makes it available to the assistant; you choose when to send a personal reply.</p>
    {!faq&&!error&&<p role="status">Loading FAQ…</p>}
    {faq&&<form onSubmit={save}>
      <label>Question<textarea dir="auto" maxLength={1000} rows={2} required value={faq.question} disabled={busy} onChange={e=>{setFaq({...faq,question:e.target.value});setSaved(false);onDirty(true);}}/></label>
      <label>Confirmed answer<textarea dir="auto" maxLength={10000} rows={4} required value={faq.answer} disabled={busy} onChange={e=>{setFaq({...faq,answer:e.target.value});setSaved(false);onDirty(true);}}/></label>
      <label>Language<select value={faq.locale} disabled={busy} onChange={e=>{setFaq({...faq,locale:e.target.value});setSaved(false);onDirty(true);}}><option value="en">English</option><option value="ar">Arabic</option></select></label>
      <div className="gap-faq-actions"><button className="primary" disabled={busy||saved||!faq.question.trim()||!faq.answer.trim()}>{busy?'Saving…':'Save FAQ'}</button>
        {saved&&<button type="button" className="secondary" disabled={busy} onClick={async()=>{setBusy(true);try{await onPrepare(faq.answer);}finally{setBusy(false);}}}>Prepare personal reply</button>}</div>
      {saved&&<p className="success" role="status">Saved to FAQs. This review stays open until you resolve it.</p>}
    </form>}
    {error&&<p className="error" role="alert">{error}</p>}
  </section>;
}
