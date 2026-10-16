
import ExcelJS from "npm:exceljs@4.4.0";
import { Buffer } from "node:buffer";
import { createClient } from "npm:@supabase/supabase-js@2.57.0";

const EXPECTED_ID = "1nzFExZ-mz09ygNfYyJZYEEhzMiDtRT7F";
const EXPECTED_SHA = "5022011aade1192d8a20834993489b93b3a2e13b368ec1bc98def2c487e5c11c";
const EXPECTED_COUNT = 36175;
const EXPECTED_CENTS = 139420556835;
const EXPECTED_SHEET = "HISTORICO PGTOS";

function response(value: unknown, status=200) {return Response.json(value,{status});}
async function authorized(req: Request) {
 const expected=Deno.env.get("BRIDGE_WEBHOOK_SECRET")??"";
 const given=req.headers.get("x-bridge-secret")??"";
 if(expected.length<32 || given.length<32)return false;
 const [a,b]=await Promise.all([expected,given].map(s=>crypto.subtle.digest("SHA-256",new TextEncoder().encode(s))));
 const x=new Uint8Array(a),y=new Uint8Array(b);
 return x.reduce((v,c,i)=>v|(c^y[i]),0)===0;
}
function norm(value:unknown){
 return String(value??"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim().toUpperCase().replace(/\s+/g," ");
}
function valueOf(cell: ExcelJS.Cell): unknown {
 const val=cell.value;
 if(val && typeof val==="object" && !(val instanceof Date)){
  const o=val as unknown as Record<string,unknown>;
  if("result" in o)return o.result;
  if("text" in o)return o.text;
  if(Array.isArray(o.richText))return o.richText.map(t=>(t as {text?:string}).text??"").join("");
 }
 return val;
}
function dateOf(x:unknown):string|null {
 if(x instanceof Date)return Number.isFinite(+x)?x.toISOString().slice(0,10):null;
 if(typeof x==="number" && x>10000 && x<100000)return new Date(Date.UTC(1899,11,30)+Math.floor(x)*86400000).toISOString().slice(0,10);
 const s=String(x??"").trim();
 if(/^\d{4}-\d{2}-\d{2}$/.test(s))return s;
 const d=s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
 if(!d)return null;
 const yyyy=+d[3],mm=+d[2],dd=+d[1];
 const dt=new Date(Date.UTC(yyyy,mm-1,dd));
 return dt.getUTCFullYear()===yyyy&&dt.getUTCMonth()+1===mm&&dt.getUTCDate()===dd?
  [d[3],d[2].padStart(2,"0"),d[1].padStart(2,"0")].join("-"):null;
}
function currencyOf(x:unknown):number|null{
 if(typeof x==="number")return Number.isFinite(x)?Math.round(x*100):null;
 let t=String(x??"").replace(/R\$/gi,"").replace(/\s/g,"");
 if(!t)return null;
 if(t.includes(","))t=t.replace(/\./g,"").replace(",",".");
 const value=Number(t);
 return Number.isFinite(value)?Math.round(value*100):null;
}
type Row = {
 source_row:number;source_sheet:string;customer_code:string;customer_name:string;seller:string;
 sap:string;invoice:string;issue_date:string|null;due_date:string;payment_date:string;
 amount:number;days_delay:number;source_status:string;prazo_pgto:number|null;
};
function parseSheet(book:ExcelJS.Workbook){
 const sheet=book.getWorksheet(EXPECTED_SHEET);
 if(!sheet)throw new Error("EXPECTED_SHEET_MISSING");
 const headers:Record<string,number>={};
 sheet.getRow(1).eachCell({includeEmpty:false},(c,n)=>{
  headers[norm(valueOf(c))]=n;
 });
 const required=["CUSTOMER ID","NAME","INVOICE NUMBER","INVOICE DATE","DUE DATE","PAYMENT DATE","INVOICE VALUE","PRAZO PGTO","EM DIA/EM ATRASO"];
 if(required.some(k=>!headers[k]))throw new Error("PAYMENT_HEADER_MISMATCH");
 const get=(row:ExcelJS.Row,name:string)=>valueOf(row.getCell(headers[name]));
 const rows:Row[]=[];
 let totalCents=0,sourceLate=0,sourceOnTime=0,oneDayGrace=0;
 for(let i=2;i<=sheet.rowCount;i++){
  const r=sheet.getRow(i),name=String(get(r,"NAME")??"").trim();
  if(!name)throw new Error("EMPTY_CUSTOMER_IN_ROW_"+i);
  const due=dateOf(get(r,"DUE DATE"));
  const paid=dateOf(get(r,"PAYMENT DATE"));
  const issue=dateOf(get(r,"INVOICE DATE"));
  const cents=currencyOf(get(r,"INVOICE VALUE"));
  const originalStatus=norm(get(r,"EM DIA/EM ATRASO"));
  if(!due||!paid||!issue||cents===null||
   !["EM DIA","EM ATRASO"].includes(originalStatus))
    throw new Error("INVALID_PAYMENT_ROW_"+i);
  const days=Math.round((Date.parse(paid+"T00:00:00Z")-Date.parse(due+"T00:00:00Z"))/86400000);
  // A planilha original considera pagamentos um dia após o vencimento como EM DIA.
  // Preservar a classificação da fonte e registrar os dias efetivos separadamente.
  if((days>1)!==(originalStatus==="EM ATRASO"))
    throw new Error("PAYMENT_STATUS_MISMATCH_ROW_"+i);
  if(days===1&&originalStatus==="EM DIA")oneDayGrace++;
  const term=Number(get(r,"PRAZO PGTO"));
  rows.push({
   source_row:i,source_sheet:sheet.name,
   customer_code:String(get(r,"CUSTOMER ID")??"").trim(),
   customer_name:name,seller:"",sap:"",
   invoice:String(get(r,"INVOICE NUMBER")??"").trim(),
   issue_date:issue,due_date:due,payment_date:paid,
   amount:cents/100,days_delay:days,source_status:originalStatus,
   prazo_pgto:Number.isInteger(term)?term:null
  });
  totalCents+=cents;
  if(originalStatus==="EM ATRASO")sourceLate++;else sourceOnTime++;
 }
 if(rows.length!==EXPECTED_COUNT||totalCents!==EXPECTED_CENTS)
  throw new Error("FILE_TOTALS_MISMATCH: rows="+rows.length+" cents="+totalCents);
 return {rows,totalCents,sourceLate,sourceOnTime,oneDayGrace};
}

Deno.serve(async req=>{
 if(req.method!=="POST")return response({error:"METHOD_NOT_ALLOWED"},405);
 if(!(await authorized(req)))return response({error:"UNAUTHORIZED"},401);
 try{
  const body=await req.json();
  const mode=body.mode==="commit"?"commit":"validate";
  if(body.fileId!==EXPECTED_ID)return response({error:"UNEXPECTED_SOURCE_ID"},400);
  const filename=String(body.fileName||"");
  const content=String(body.contentBase64||"");
  if(!/\.xlsx$/i.test(filename)||content.length<1||content.length>9_000_000)
    return response({error:"EXPECTED_XLSX_UNDER_6MB"},400);
  const bytes=Uint8Array.from(atob(content),c=>c.charCodeAt(0));
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)))
   .map(v=>v.toString(16).padStart(2,"0")).join("");
  if(hash!==EXPECTED_SHA)return response({error:"SOURCE_HASH_CHANGED_REVALIDATE"},409);
  const workbook=new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(bytes));
  const parsed=parseSheet(workbook);
  const preview={fileName:filename,
   sourceHash:hash,rowCount:parsed.rows.length,totalReceived:parsed.totalCents/100,
   sourceOnTime:parsed.sourceOnTime,sourceOverdue:parsed.sourceLate,
   oneDayGraceClassifications:parsed.oneDayGrace,
   dateRule:"Classificação EM DIA/EM ATRASO preservada da planilha; tolerância observada de 1 dia.",
   valueRule:"O XLSX contém INVOICE VALUE; é valor da nota nos registros de pagamentos."};
  if(mode==="validate")return response({status:"VALIDATED_NO_WRITE",...preview});
  if(Deno.env.get("BRIDGE_WRITE_ENABLED")!=="true")
   return response({error:"WRITES_DISABLED",...preview},403);
  const url=Deno.env.get("SUPABASE_URL");
  const legacy=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  let key=legacy;
  if(!key){
   try{const keys=JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")||"{}");key=keys.default;}catch{}
  }
  if(!url||!key)return response({error:"SERVER_CREDENTIALS_NOT_CONFIGURED"},503);
  const client=createClient(url,key,{auth:{persistSession:false}});
  const source=String(body.fileId);
  const begin=await client.rpc("begin_payment_history_import",{
   p_source_key:source,p_file_name:filename,p_sha256:hash,
   p_expected_count:parsed.rows.length,p_expected_total:(parsed.totalCents/100).toFixed(2)
  });
  if(begin.error)return response({error:"IMPORT_BEGIN_FAILED",detail:begin.error.message},409);
  if(begin.data?.status==="UNCHANGED")return response({status:"IMPORTED",database:begin.data,...preview});
  const chunkSize=700;
  let chunks=0;
  for(let offset=0;offset<parsed.rows.length;offset+=chunkSize){
   const part=parsed.rows.slice(offset,offset+chunkSize);
   const append=await client.rpc("append_payment_history_chunk",{
     p_source_key:source,p_sha256:hash,p_rows:part
   });
   if(append.error)return response({
    error:"IMPORT_CHUNK_FAILED",detail:append.error.message,atRow:part[0].source_row,
    stagedRows:offset,canRetry:true
   },409);
   chunks++;
  }
  const complete=await client.rpc("finish_payment_history_import",{
    p_source_key:source,p_sha256:hash
  });
  if(complete.error)return response({
    error:"IMPORT_RECONCILIATION_FAILED",detail:complete.error.message,canRetry:true
  },409);
  return response({status:"IMPORTED",database:complete.data,chunks,...preview});
 }catch(err){
  return response({error:"PAYMENT_WORKBOOK_FAILED",detail:err instanceof Error?err.message:String(err)},422);
 }
});
