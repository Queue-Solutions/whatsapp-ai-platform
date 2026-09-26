import {describe,expect,it} from 'vitest';
import ExcelJS from 'exceljs';
import {buildAnalyticsWorkbook,spreadsheetText} from '../src/modules/admin/analytics-workbook';
import type {AnalyticsReport} from '../src/modules/admin/analytics';

const report:AnalyticsReport={
  summary:{customers:1,chats:1,inboundMessages:3,spamOrFraud:1,abuseOrSexualHarassment:0,complaints:1,contactRequests:0,knowledgeGaps:1},
  series:[{period:'2026-09-20T00:00:00Z',customers:1,spamOrFraud:1,abuseOrSexualHarassment:0,complaints:1,contactRequests:0}],
  customers:[{id:'10000000-0000-4000-8000-000000000001',name:'=HYPERLINK("bad")',phone:'+201000000001',username:null,firstContact:'2026-09-20T10:00:00Z',lastContact:'2026-09-20T11:00:00Z',inboundMessages:3,chats:1,spamOrFraud:1,abuseOrSexualHarassment:0,complaints:1,contactRequests:0,knowledgeGaps:1}],
  recommendations:[{kind:'faq_gap',topic:'=Unsafe topic',mentions:3,customers:1,lastSeen:'2026-09-20T11:00:00Z',reason:'Add a confirmed FAQ.'}],
};
describe('analytics Excel workbook',()=>{
  it('creates organized typed sheets and neutralizes formula-like customer data',async()=>{
    const bytes=await buildAnalyticsWorkbook(report,{business:'Demo',from:'2026-09-01T00:00:00Z',to:'2026-10-01T00:00:00Z',granularity:'day'});
    const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(bytes);
    expect(workbook.worksheets.map(sheet=>sheet.name)).toEqual(['Summary','Customers','Recommendations']);
    expect(workbook.getWorksheet('Summary')?.getCell('B5').value).toBe(1);
    expect(workbook.getWorksheet('Customers')?.getCell('A5').value).toBe("'=HYPERLINK(\"bad\")");
    expect(workbook.getWorksheet('Customers')?.getCell('B5').value).toBe("'+201000000001");
    expect(workbook.getWorksheet('Recommendations')?.getCell('B5').value).toBe("'=Unsafe topic");
    expect(workbook.getWorksheet('Customers')?.views[0]).toMatchObject({state:'frozen',ySplit:4});
  });
  it('escapes every formula prefix while preserving ordinary identifiers',()=>{
    expect(['=x','+x','-x','@x'].map(spreadsheetText)).toEqual(["'=x","'+x","'-x","'@x"]);expect(spreadsheetText('201000000001')).toBe('201000000001');
  });
});
