'use client';
import {useEffect,useMemo,useState} from 'react';
import type {SupabaseClient} from '@supabase/supabase-js';
import {KnowledgeEditor} from '@/modules/admin/knowledge-editor';
import {AnalyticsRepository} from '@/modules/admin/analytics';

/** Counts current derived recommendations across the signed-in user's RLS memberships. */
export function RecommendationIndicator({db}:{db:SupabaseClient}){
  const repository=useMemo(()=>new AnalyticsRepository(db),[db]);
  const [count,setCount]=useState(0),[unavailable,setUnavailable]=useState(false);
  useEffect(()=>{
    let active=true,running=false,tenants:string[]=[];
    const load=async()=>{
      if(running)return;running=true;
      try{
        if(!tenants.length)tenants=(await new KnowledgeEditor(db).memberships()).map(row=>row.tenant_id);
        const rows=await Promise.all(tenants.map(tenant=>repository.recommendations(tenant)));
        if(active){setCount(rows.reduce((sum,recommendations)=>sum+recommendations.length,0));setUnavailable(false);}
      }catch{if(active)setUnavailable(true);}finally{running=false;}
    };
    void load();const timer=setInterval(()=>void load(),10000);
    window.addEventListener('recommendations-updated',load);window.addEventListener('focus',load);
    return()=>{active=false;clearInterval(timer);window.removeEventListener('recommendations-updated',load);window.removeEventListener('focus',load);};
  },[db,repository]);
  if(unavailable)return <span className="recommendation-indicator" role="status" title="Recommendation count unavailable. Open AI recommendations to retry.">!</span>;
  if(!count)return null;
  return <span className="recommendation-indicator" role="status" aria-label={`${count} new AI recommendation${count===1?'':'s'}`} title={`${count} new AI recommendation${count===1?'':'s'}`}>{count}</span>;
}
