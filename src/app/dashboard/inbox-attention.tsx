'use client';
import {useEffect,useRef,useState} from 'react';
import type {SupabaseClient} from '@supabase/supabase-js';

/** Counts only rows visible to this authenticated user's RLS membership. No message content is fetched. */
export function AttentionLink({db,compact=false}:{db:SupabaseClient;compact?:boolean}) {
  const [count,setCount]=useState(0);
  const [newCase,setNewCase]=useState(false);
  const [unavailable,setUnavailable]=useState(false);
  const previous=useRef<Set<string>|null>(null);
  useEffect(()=>{
    let active=true;let running=false;
    const load=async()=>{
      if(running)return;running=true;
      try {
        const {data,count,error}=await db.from('conversations').select('id,attention_since',{count:'exact'})
          .in('attention_state',['waiting','in_progress']).order('attention_since',{ascending:false}).limit(20);
        if(error)throw error;
        if(active){
          const keys=new Set((data??[]).map(c=>`${c.id}:${c.attention_since}`));
          if(previous.current&&[...keys].some(key=>!previous.current!.has(key)))setNewCase(true);
          previous.current=keys;setCount(count??0);setUnavailable(false);
        }
      }catch{if(active)setUnavailable(true);}finally{running=false;}
    };
    void load();const timer=setInterval(()=>void load(),10000);
    return()=>{active=false;clearInterval(timer);};
  },[db]);
  if(compact)return count>0&&!unavailable?<span className="inbox-count" aria-label={`${count} conversations need attention`}>{count}</span>:null;
  if(unavailable)return <span className="attention-unavailable" role="status">Inbox alerts unavailable · open Inbox to retry</span>;
  if(!count)return null;
  return <a className="attention-alert" aria-label={`${count} conversations need your attention. Open Inbox.`} href="/dashboard/inbox?filter=attention" onClick={()=>setNewCase(false)}>
    <span aria-hidden="true" className="alert-dot"/><span role="status">{newCase?'New conversation needs you':`${count} conversation${count===1?'':'s'} need${count===1?'s':''} you`}</span><span aria-hidden="true">→</span>
  </a>;
}
