import Link from 'next/link';
export default function Home(){return <main style={{maxWidth:760,margin:'12vh auto',padding:32}}>
  <p style={{letterSpacing:2,fontSize:12}}>QUEUE SOLUTIONS</p>
  <h1>Your business knowledge, all in one place.</h1>
  <p>Manage your branches, opening hours and customer questions in your business workspace.</p>
  <Link href="/dashboard" style={{display:'inline-block',marginTop:20,padding:'13px 22px',background:'#245b48',color:'white',borderRadius:8,textDecoration:'none'}}>Open dashboard →</Link>
</main>;}
