'use client';
import {useEffect,useState} from 'react';
import type {SupabaseClient} from '@supabase/supabase-js';

/** RLS restricts this exact count to the signed-in user's business memberships. */
export function BlacklistIndicator({db}:{db:SupabaseClient}){
  const [count,setCount]=useState(0),[unavailable,setUnavailable]=useState(false);
  useEffect(()=>{
    let active=true,running=false;
    const load=async()=>{
      if(running)return;running=true;
      try{
        const {count,error}=await db.from('customer_blacklist').select('customer_id',{count:'exact',head:true}).in('state',['pending_review','kept']);
        if(error)throw error;
        if(active){setCount(count??0);setUnavailable(false);}
      }catch{if(active)setUnavailable(true);}finally{running=false;}
    };
    void load();const timer=setInterval(()=>void load(),10000);
    window.addEventListener('blacklist-updated',load);
    window.addEventListener('focus',load);
    return()=>{active=false;clearInterval(timer);window.removeEventListener('blacklist-updated',load);window.removeEventListener('focus',load);};
  },[db]);
  if(unavailable)return <span className="blacklist-count" role="status" title="Blacklist count unavailable. Open Blacklist to review.">!</span>;
  if(!count)return null;
  return <span className="blacklist-count" role="status" aria-label={`${count} customers added to the blacklist`} title={`${count} customers added to the blacklist`}>{count} blocked</span>;
}
