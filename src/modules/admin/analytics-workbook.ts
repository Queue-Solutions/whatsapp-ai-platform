import ExcelJS from 'exceljs';
import type {AnalyticsReport} from './analytics';

const green='245B48',pale='EDF3EA',ink='203631',muted='6F7F79',line='DCE5DC';
export function spreadsheetText(value:string|null|undefined){const text=value??'';return /^[=+\-@]/.test(text)?`'${text}`:text;}
function title(sheet:ExcelJS.Worksheet,text:string,subtitle:string){sheet.mergeCells('A1:H1');sheet.getCell('A1').value=text;sheet.getCell('A1').font={name:'Aptos Display',size:22,bold:true,color:{argb:`FF${ink}`}};sheet.getCell('A1').alignment={vertical:'middle'};sheet.getRow(1).height=34;sheet.mergeCells('A2:H2');sheet.getCell('A2').value=subtitle;sheet.getCell('A2').font={name:'Aptos',size:10,color:{argb:`FF${muted}`}};sheet.getRow(2).height=24;}
function tableStyle(sheet:ExcelJS.Worksheet,row:number){const header=sheet.getRow(row);header.font={name:'Aptos',size:10,bold:true,color:{argb:'FFFFFFFF'}};header.fill={type:'pattern',pattern:'solid',fgColor:{argb:`FF${green}`}};header.height=22;header.eachCell(cell=>{cell.alignment={vertical:'middle'};});}
function outline(sheet:ExcelJS.Worksheet){sheet.views=[{state:'frozen',ySplit:4,showGridLines:false}];sheet.properties.defaultRowHeight=20;sheet.eachRow(row=>row.eachCell(cell=>{cell.font={name:'Aptos',size:10,...cell.font};cell.border={bottom:{style:'hair',color:{argb:`FF${line}`}}};cell.alignment={vertical:'middle',wrapText:false,...cell.alignment};}));}

export async function buildAnalyticsWorkbook(report:AnalyticsReport,options:{business:string;from:string;to:string;granularity:string}){
  const workbook=new ExcelJS.Workbook();workbook.creator='Queue Solutions';workbook.created=new Date();workbook.modified=new Date();workbook.calcProperties.fullCalcOnLoad=true;
  const summary=workbook.addWorksheet('Summary',{properties:{tabColor:{argb:`FF${green}`}}});
  title(summary,`${spreadsheetText(options.business)} chat analytics`,`${new Date(options.from).toLocaleDateString()} to ${new Date(new Date(options.to).getTime()-1).toLocaleDateString()} · ${options.granularity} chart interval`);
  summary.columns=[{width:32},{width:18},{width:24},{width:18},{width:18},{width:18},{width:18},{width:18}];
  summary.addRow([]);summary.addRow(['Metric','Customers / count']);tableStyle(summary,4);
  const metrics:[string,number][]=[['Customers reached',report.summary.customers],['Chats',report.summary.chats],['Inbound messages',report.summary.inboundMessages],['Spam or fraud',report.summary.spamOrFraud],['Abuse or sexual harassment',report.summary.abuseOrSexualHarassment],['Complaints',report.summary.complaints],['Asked for contact',report.summary.contactRequests],['Knowledge gaps',report.summary.knowledgeGaps]];
  for(const metric of metrics)summary.addRow(metric);summary.getColumn(2).numFmt='#,##0';
  summary.addRow([]);const trendHeader=summary.rowCount+1;summary.addRow(['Period','Customers','Spam or fraud','Abuse or sexual harassment','Complaints','Contact requests']);tableStyle(summary,trendHeader);
  for(const row of report.series)summary.addRow([new Date(row.period),row.customers,row.spamOrFraud,row.abuseOrSexualHarassment,row.complaints,row.contactRequests]);
  summary.getColumn(1).numFmt='mmm d, yyyy';outline(summary);

  const customers=workbook.addWorksheet('Customers',{properties:{tabColor:{argb:'FF6685A7'}}});
  title(customers,'Customer detail','One row per customer with chat activity or an attention signal in the selected period.');
  customers.columns=[{width:28},{width:20},{width:18},{width:16},{width:16},{width:13},{width:10},{width:16},{width:12},{width:12},{width:14},{width:16},{width:15}];
  customers.addRow([]);customers.addRow(['Customer name','Phone number','Username','First contact','Last contact','Inbound messages','Chats','Spam or fraud','Abuse','Complaints','Contact requests','Knowledge gaps','Customer ID']);tableStyle(customers,4);
  for(const row of report.customers)customers.addRow([spreadsheetText(row.name),spreadsheetText(row.phone),spreadsheetText(row.username),row.firstContact?new Date(row.firstContact):null,row.lastContact?new Date(row.lastContact):null,row.inboundMessages,row.chats,row.spamOrFraud,row.abuseOrSexualHarassment,row.complaints,row.contactRequests,row.knowledgeGaps,row.id]);
  customers.getColumn(2).numFmt='@';customers.getColumn(3).numFmt='@';customers.getColumn(4).numFmt='mmm d, yyyy h:mm AM/PM';customers.getColumn(5).numFmt='mmm d, yyyy h:mm AM/PM';customers.autoFilter={from:{row:4,column:1},to:{row:4,column:13}};outline(customers);

  const recommendations=workbook.addWorksheet('Recommendations',{properties:{tabColor:{argb:'FFD29A48'}}});
  title(recommendations,'AI recommendations','Repeated FAQ opportunities and complaint themes from the selected period.');
  recommendations.columns=[{width:22},{width:50},{width:12},{width:12},{width:18},{width:72},{width:18},{width:18}];
  recommendations.addRow([]);recommendations.addRow(['Type','Topic','Mentions','Customers','Last seen','Recommendation']);tableStyle(recommendations,4);
  for(const row of report.recommendations)recommendations.addRow([row.kind==='faq_gap'?'FAQ opportunity':'Complaint theme',spreadsheetText(row.topic),row.mentions,row.customers,new Date(row.lastSeen),spreadsheetText(row.reason)]);
  recommendations.getColumn(5).numFmt='mmm d, yyyy';recommendations.autoFilter={from:{row:4,column:1},to:{row:4,column:6}};outline(recommendations);
  for(const sheet of workbook.worksheets){sheet.pageSetup={orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:0,margins:{left:.3,right:.3,top:.5,bottom:.5,header:.2,footer:.2}};sheet.headerFooter.oddFooter='&LQueue Solutions&CPage &P of &N&RConfidential';sheet.getCell('A1').fill={type:'pattern',pattern:'solid',fgColor:{argb:`FF${pale}`}};}
  return workbook.xlsx.writeBuffer();
}
