import { readAiMode } from '@/modules/ai/config';
export const dynamic = 'force-dynamic';
export function GET(){return Response.json({status:'ok',mode:'test',replyStrategy:readAiMode()});}
