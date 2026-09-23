import {describe,it,expect,vi} from 'vitest';
import {GroundedStrategy} from '../src/modules/ai/grounded-strategy';
import {isRepairEnquiry} from '../src/modules/ai/repair-faq';
import type {KnowledgeSource} from '../src/modules/ai/contracts';
import type {MessageContext} from '../src/modules/messaging/types';

const answer=`Technical Care working hours and available branches:
Daily from 1:00 PM to 9:00 PM, except Sunday (weekly day off), and Friday from 2:00 PM to 9:00 PM.
Available branches:
1️⃣ IRAM KORBA (Heliopolis)
2️⃣ IRAM NOX (Fifth Settlement)
3️⃣ IRAM ZIA (South 90th Street)
4️⃣ IRAM ARKAN (Sheikh Zayed)
5️⃣ IRAM ALEX (Roshdy)
6️⃣ Hurghada
You may drop off the product at any of our other branches for maintenance and collect it later from the same branch.`;
const repair:KnowledgeSource={id:'repair',kind:'faq',label:'F7',updatedAt:'2026-09-21',content:JSON.stringify({question:'What technical care, maintenance, or repair services do you offer?',answer})};
const context:MessageContext={tenantId:'tenant',conversationId:'conversation',requestKey:'message:repair',type:'text',text:'عايز اصلح سلسلة جبتها من عندكم',history:[{role:'assistant',content:'مهتم بالمجوهرات ولا منتجات BTC والسبائك؟'}]};
const ledger=()=>({reserve:vi.fn(),finish:vi.fn()});

describe('approved repair FAQ routing',()=>{
 it.each(['عايز اصلح سلسلة جبتها من عندكم','محتاج تصليح خاتم','السلسلة بايظة وعايز أصلحها'])('answers the Arabic repair request directly: %s',async text=>{
  const usage=ledger(),complete=vi.fn();
  const decision=await new GroundedStrategy(async()=>[repair],usage,{complete}).reply({...context,text,requestKey:`message:${text}`});
  expect(decision).toMatchObject({action:'answer',reason:'approved_knowledge',sources:[{id:'repair'}]});
  expect(decision.text).toContain('مواعيد العناية الفنية والصيانة');expect(decision.text).toContain('يوميًا من 1:00 PM إلى 9:00 PM');
  expect(decision.text).toContain('• IRAM KORBA (Heliopolis)');expect(decision.text).toContain('• Hurghada');expect(decision.text).toContain('أي فرع من فروعنا الأخرى');
  expect(decision.text).not.toMatch(/شكرًا لتواصلك|توضح طلبك|المجوهرات ولا منتجات BTC|Technical Care/);expect(complete).not.toHaveBeenCalled();expect(usage.reserve).not.toHaveBeenCalled();
 });
 it('keeps the approved English FAQ answer for an English repair request',async()=>{
  const complete=vi.fn(),decision=await new GroundedStrategy(async()=>[repair],ledger(),{complete}).reply({...context,text:'I need to repair a necklace I bought from you'});
  expect(decision.text).toBe(answer);expect(complete).not.toHaveBeenCalled();
 });
 it('does not confuse a new jewelry purchase with a repair request',()=>{
  expect(isRepairEnquiry('عايز اشتري سلسلة من عندكم')).toBe(false);expect(isRepairEnquiry('السلسلة دي تصلح هدية؟')).toBe(false);
  expect(isRepairEnquiry('I want to buy a necklace')).toBe(false);expect(isRepairEnquiry('Do you have fixed prices?')).toBe(false);
 });
});
