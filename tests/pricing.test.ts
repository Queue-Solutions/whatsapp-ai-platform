import {describe,it,expect,vi} from 'vitest';
import {GroundedStrategy} from '../src/modules/ai/grounded-strategy';
import type {MessageContext} from '../src/modules/messaging/types';

const base:MessageContext={tenantId:'tenant-a',conversationId:'conversation-a',requestKey:'message:price',type:'text',eligible:true,text:'بكام؟',history:[{role:'user',content:'عندكم جنيهات دهب؟'}]};
const ledger={reserve:vi.fn(),finish:vi.fn()};

describe('live price policy',()=>{
  it.each(['بكام؟','ايه سعر جنيه الذهب؟','What is the price?','How much does it cost?'])('answers %s without knowledge-gap escalation or a model call',async text=>{
    const load=vi.fn(),complete=vi.fn();
    const decision=await new GroundedStrategy(load,ledger,{complete}).reply({...base,text,requestKey:`price:${text}`});
    expect(decision).toMatchObject({action:'answer',reason:'live_price_information',sources:[]});
    expect(decision.followUp).toBeUndefined();expect(decision.text).toMatch(/بتتغير باستمرار|change constantly/);
    expect(decision.text).toMatch(/تزور أي فرع|visit any IRAM branch/);expect(load).not.toHaveBeenCalled();expect(complete).not.toHaveBeenCalled();
  });

  it('explains why after a price question instead of repeating legacy contact collection',async()=>{
    const decision=await new GroundedStrategy(vi.fn(),ledger,{complete:vi.fn()}).reply({...base,text:'ليه كده؟',requestKey:'price:why',
      history:[{role:'user',content:'بكام؟'},{role:'assistant',content:'سيتابع أحد ممثلي IRAM طلبك بصورة شخصية.\n\nيرجى إرسال اسمك ورقم الهاتف الأنسب للتواصل.'}],
      followUp:{state:'collecting',name:null,phone:null,reason:'missing_business_information',summary:'السعر غير متاح'}});
    expect(decision).toMatchObject({action:'answer',reason:'live_price_information'});expect(decision.followUp).toBeUndefined();
    expect(decision.text).toContain('لأن الأسعار بتتغير باستمرار');expect(decision.text).not.toMatch(/يرجى إرسال اسمك|سيتابع أحد ممثلي/);
  });

  it('gives a reason-aware explanation for a genuine missing-information follow-up',async()=>{
    const decision=await new GroundedStrategy(vi.fn(),ledger,{complete:vi.fn()}).reply({...base,text:'ليه كده؟',requestKey:'gap:why',history:[],
      followUp:{state:'collecting',name:null,phone:null,reason:'missing_business_information',summary:'تفاصيل تغليف خاصة غير مؤكدة'}});
    expect(decision.reason).toBe('missing_business_information');expect(decision.followUp?.state).toBe('collecting');
    expect(decision.text).toContain('المعلومة المطلوبة غير متاحة للمساعد الذكي');expect(decision.text).toContain('يرجى إرسال اسمك ورقم الهاتف');
  });
});
