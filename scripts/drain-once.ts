async function main(){
  const base=process.env.SMOKE_BASE_URL??'http://localhost:3000';
  const secret=process.env.CRON_SECRET;
  if(!secret)throw new Error();
  const response=await fetch(`${base}/api/internal/process-messages`,{method:'POST',headers:{authorization:`Bearer ${secret}`}});
  console.log(`Worker HTTP ${response.status}`);
  if(!response.ok)process.exitCode=1;
}
main().catch(()=>{console.error('Worker request failed');process.exitCode=1;});
